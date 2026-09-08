import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSettingsState } from './use-terminal-settings-state'
import type {
  TerminalSettingsOperations,
  TerminalSettingsHost
} from './terminal-settings-operations'

let renderer: ReactTestRenderer | undefined
let state: ReturnType<typeof useTerminalSettingsState>
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})
function fixture() {
  return {
    loadPreferences: vi.fn().mockResolvedValue({ textScale: 1.25, autocompleteEnabled: true }),
    saveTextScale: vi.fn().mockResolvedValue(undefined),
    saveAutocomplete: vi.fn().mockResolvedValue(undefined)
  } as unknown as TerminalSettingsOperations
}
async function mount(operations: TerminalSettingsOperations, hosts: TerminalSettingsHost[] = []) {
  function Harness() {
    state = useTerminalSettingsState(hosts, operations)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
describe('terminal settings state', () => {
  it('does not enable preferences until storage loads or show a change before it saves', async () => {
    const load = deferred<{ textScale: number; autocompleteEnabled: boolean }>()
    const save = deferred<void>()
    const operations = fixture()
    vi.mocked(operations.loadPreferences).mockReturnValue(load.promise)
    vi.mocked(operations.saveAutocomplete).mockReturnValue(save.promise)
    await mount(operations)
    expect(state.busy).toBe(true)
    await act(async () => {
      load.resolve({ textScale: 1.5, autocompleteEnabled: false })
    })
    expect(state.textScale).toBe(1.5)
    expect(state.busy).toBe(false)
    act(() => state.toggleAutocomplete(true))
    expect(state.busy).toBe(true)
    expect(state.autocompleteEnabled).toBe(false)
    await act(async () => {
      save.resolve()
    })
    expect(state.busy).toBe(false)
    expect(state.autocompleteEnabled).toBe(true)
  })
  it('releases the controls when storage cannot be read', async () => {
    const operations = fixture()
    vi.mocked(operations.loadPreferences).mockRejectedValue(new Error('storage unavailable'))
    await mount(operations)
    expect(state.busy).toBe(false)
    expect(state.error).toContain('Could not load')
  })
  it('preserves the confirmed setting when saving fails', async () => {
    const operations = fixture()
    vi.mocked(operations.saveTextScale).mockRejectedValue(new Error('storage unavailable'))
    await mount(operations)
    await act(async () => {
      state.selectTextSize('largest')
    })
    expect(state.textScale).toBe(1.25)
    expect(state.busy).toBe(false)
    expect(state.error).toContain('Could not save')
  })
  it('reflects the host acknowledgement and never retries failed host mutations', async () => {
    const host = {
      id: 'host',
      name: 'Desktop',
      loadFit: vi.fn().mockResolvedValue(null),
      saveFit: vi.fn().mockResolvedValue(75000)
    }
    await mount(fixture(), [host])
    await act(async () => {
      await state.selectValue('host', '60s')
    })
    expect(state.hostMs.host).toBe(75000)
    host.saveFit.mockRejectedValue(new Error('connection lost'))
    await act(async () => {
      await state.selectValue('host', '5m')
    })
    expect(state.hostMs.host).toBe(75000)
    expect(host.saveFit).toHaveBeenCalledTimes(2)
    expect(state.error).toContain('Could not save')
  })
})
