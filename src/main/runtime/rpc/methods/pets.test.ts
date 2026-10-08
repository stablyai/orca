import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { CustomPet } from '../../../../shared/pet-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'

const { importPetBundleFromPathMock, removePetFilesMock } = vi.hoisted(() => ({
  importPetBundleFromPathMock: vi.fn(),
  removePetFilesMock: vi.fn()
}))

vi.mock('../../../ipc/pet-file-removal', () => ({
  removePetFiles: removePetFilesMock
}))

const { PET_METHODS } = await import('./pets')

const LEONARDO: CustomPet = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Leonardo da Vinci',
  fileName: 'spritesheet.webp',
  mimeType: 'image/webp',
  kind: 'bundle'
}
const CAT: CustomPet = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Cat',
  fileName: '22222222-2222-4222-8222-222222222222.png',
  mimeType: 'image/png'
}
const CAT_ENTRY = { id: CAT.id, name: 'Cat', kind: 'image' }

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function setup(initial: Partial<PersistedUIState>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pet methods read only pet fields.
  let ui = { ...initial } as PersistedUIState
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getUIState: vi.fn(() => ui),
    updateUIState: vi.fn((updates: Partial<PersistedUIState>) => {
      ui = { ...ui, ...updates }
      return ui
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher only calls the stubbed methods.
  const typedRuntime = runtime as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime: typedRuntime, methods: PET_METHODS })
  return { dispatcher, runtime, ui: () => ui }
}

beforeEach(() => {
  importPetBundleFromPathMock.mockReset()
  removePetFilesMock.mockReset()
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => null,
    importPetBundle: importPetBundleFromPathMock,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
})

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

describe('pet RPC methods', () => {
  it('lists built-in and custom pets and reports the default as active for an unknown id', async () => {
    const { dispatcher } = setup({ customPets: [LEONARDO], petId: 'removed-elsewhere' })

    const response = await dispatcher.dispatch(makeRequest('pet.list'))

    expect(response).toMatchObject({
      ok: true,
      result: {
        activePetId: 'claude-the-mage',
        visible: true,
        pets: [
          { id: 'claude-the-mage', name: null, kind: 'built-in', active: true },
          { id: 'opencode-the-rogue', kind: 'built-in', active: false },
          { id: 'gremlin-the-trickster', kind: 'built-in', active: false },
          { id: LEONARDO.id, name: 'Leonardo da Vinci', kind: 'bundle', active: false }
        ]
      }
    })
  })

  it('reads pets persisted under the pre-rename sidekick keys', async () => {
    const { dispatcher } = setup({ customSidekicks: [CAT], sidekickId: CAT.id })

    const response = await dispatcher.dispatch(makeRequest('pet.list'))

    expect(response).toMatchObject({
      ok: true,
      result: {
        activePetId: CAT.id,
        pets: expect.arrayContaining([{ ...CAT_ENTRY, active: true }])
      }
    })
  })

  it('imports a bundle under the given name, switches to it, and shows the overlay', async () => {
    const { dispatcher, ui } = setup({ customPets: [CAT], petId: CAT.id, petVisible: false })
    importPetBundleFromPathMock.mockResolvedValue(LEONARDO)

    const response = await dispatcher.dispatch(
      makeRequest('pet.importBundle', { path: '/pets/leonardo', name: '  Da Vinci  ' })
    )

    expect(importPetBundleFromPathMock).toHaveBeenCalledWith('/pets/leonardo')
    expect(ui()).toMatchObject({
      customPets: [CAT, { ...LEONARDO, label: 'Da Vinci' }],
      petId: LEONARDO.id,
      petVisible: true
    })
    expect(response).toMatchObject({
      ok: true,
      result: { pet: { id: LEONARDO.id, name: 'Da Vinci', kind: 'bundle' } }
    })
  })

  it('keeps a pet the renderer added while the bundle was copying', async () => {
    const { dispatcher, runtime, ui } = setup({ customPets: [] })
    importPetBundleFromPathMock.mockImplementation(async () => {
      runtime.updateUIState({ customPets: [CAT] })
      return LEONARDO
    })

    await dispatcher.dispatch(makeRequest('pet.importBundle', { path: '/pets/leonardo' }))

    expect(ui().customPets).toEqual([CAT, LEONARDO])
  })

  it('surfaces an invalid bundle without touching the pet list', async () => {
    const { dispatcher, runtime } = setup({ customPets: [CAT] })
    importPetBundleFromPathMock.mockRejectedValue(new Error('Bundle is missing pet.json.'))

    const response = await dispatcher.dispatch(
      makeRequest('pet.importBundle', { path: '/pets/empty' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'Bundle is missing pet.json.' }
    })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('deletes the copied bundle when the pet list cannot be read', async () => {
    const { dispatcher, runtime } = setup({ customPets: [] })
    importPetBundleFromPathMock.mockResolvedValue(LEONARDO)
    runtime.getUIState.mockImplementationOnce(() => {
      throw new Error('runtime_unavailable')
    })

    const response = await dispatcher.dispatch(
      makeRequest('pet.importBundle', { path: '/pets/leonardo' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(removePetFilesMock).toHaveBeenCalledWith(LEONARDO.id, 'spritesheet.webp', 'bundle')
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('refuses to import on a host without the desktop app', async () => {
    setRuntimeDesktopSurface(null)
    const { dispatcher, runtime } = setup({ customPets: [] })

    const response = await dispatcher.dispatch(
      makeRequest('pet.importBundle', { path: '/pets/leonardo' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'Importing a pet needs the Orca desktop app.' }
    })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('selects built-in pets by id and custom pets by name, un-hiding the overlay', async () => {
    const { dispatcher, ui } = setup({ customPets: [LEONARDO], petVisible: false })

    await dispatcher.dispatch(makeRequest('pet.select', { pet: 'Leonardo da Vinci' }))
    expect(ui()).toMatchObject({ petId: LEONARDO.id, petVisible: true })

    await dispatcher.dispatch(makeRequest('pet.select', { pet: 'gremlin-the-trickster' }))
    expect(ui().petId).toBe('gremlin-the-trickster')
  })

  it('rejects an unknown or ambiguous selector', async () => {
    const twin = { ...LEONARDO, id: '33333333-3333-4333-8333-333333333333' }
    const { dispatcher, runtime } = setup({ customPets: [LEONARDO, twin] })

    const unknown = await dispatcher.dispatch(makeRequest('pet.select', { pet: 'Nobody' }))
    const ambiguous = await dispatcher.dispatch(
      makeRequest('pet.select', { pet: 'Leonardo da Vinci' })
    )

    expect(unknown).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining(twin.id) }
    })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('renames a custom pet but not a built-in one', async () => {
    const { dispatcher, ui } = setup({ customPets: [LEONARDO, CAT] })

    const renamed = await dispatcher.dispatch(
      makeRequest('pet.rename', { pet: LEONARDO.id, name: 'Da Vinci' })
    )
    const builtIn = await dispatcher.dispatch(
      makeRequest('pet.rename', { pet: 'claude-the-mage', name: 'Wizard' })
    )

    expect(renamed).toMatchObject({ ok: true, result: { pet: { name: 'Da Vinci' } } })
    expect(ui().customPets).toEqual([{ ...LEONARDO, label: 'Da Vinci' }, CAT])
    expect(builtIn).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('rejects a name the pet menu would truncate', async () => {
    const { dispatcher } = setup({ customPets: [LEONARDO] })

    const response = await dispatcher.dispatch(
      makeRequest('pet.rename', { pet: LEONARDO.id, name: 'x'.repeat(41) })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('removes the active pet, falls back to the default, and deletes its files', async () => {
    const { dispatcher, ui } = setup({ customPets: [LEONARDO, CAT], petId: LEONARDO.id })

    await dispatcher.dispatch(makeRequest('pet.remove', { pet: 'Leonardo da Vinci' }))

    expect(ui()).toMatchObject({ customPets: [CAT], petId: 'claude-the-mage' })
    expect(removePetFilesMock).toHaveBeenCalledWith(LEONARDO.id, 'spritesheet.webp', 'bundle', {
      throwOnError: true
    })
  })

  it('reports files it could not delete after taking the pet off the list', async () => {
    const { dispatcher, ui } = setup({ customPets: [LEONARDO, CAT] })
    removePetFilesMock.mockRejectedValue(new Error('EBUSY: resource busy'))

    const response = await dispatcher.dispatch(makeRequest('pet.remove', { pet: LEONARDO.id }))

    expect(response).toMatchObject({
      ok: false,
      error: {
        message:
          'Removed Leonardo da Vinci from the pet list, but could not delete its files: EBUSY: resource busy'
      }
    })
    expect(ui().customPets).toEqual([CAT])
  })

  it('keeps the active pet when removing a different one', async () => {
    const { dispatcher, runtime, ui } = setup({ customPets: [LEONARDO, CAT], petId: CAT.id })

    await dispatcher.dispatch(makeRequest('pet.remove', { pet: LEONARDO.id }))

    expect(ui()).toMatchObject({ customPets: [CAT], petId: CAT.id })
    expect(runtime.updateUIState).toHaveBeenCalledWith({ customPets: [CAT] })
  })
})
