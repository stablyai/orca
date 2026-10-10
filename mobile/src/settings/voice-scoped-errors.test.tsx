import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceSettingsController } from './use-voice-settings-controller'
import { useVoiceProviderController } from './use-voice-provider-controller'
import { useVoiceScopedErrors } from './use-voice-scoped-errors'
import { cabinetState, voiceOperations } from './voice-cabinet.test-fixture'
import type { VoiceSettingsOperations } from './voice-settings-operations'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function mountHook<T>(useHook: () => T) {
  const latest: { current: T | null } = { current: null }
  function Harness() {
    latest.current = useHook()
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return () => {
    if (!latest.current) {
      throw new Error('hook did not render')
    }
    return latest.current
  }
}

async function mountController<T>(
  useController: (operations: VoiceSettingsOperations, focused: boolean) => T,
  operations: VoiceSettingsOperations
) {
  const latest: { current: T | null } = { current: null }
  function Harness() {
    latest.current = useController(operations, true)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  return () => {
    if (!latest.current) {
      throw new Error('hook did not render')
    }
    return latest.current
  }
}

describe('useVoiceScopedErrors', () => {
  it('keeps other scopes when one scope is cleared and lists the newest first', () => {
    const errors = mountHook(useVoiceScopedErrors)
    act(() => errors().setScopeError('config', 'Could not update'))
    act(() => errors().setScopeError('model', 'Disk full'))
    expect(errors().error).toBe('Disk full\nCould not update')
    expect(errors().errors).toEqual(['Disk full', 'Could not update'])

    act(() => errors().setScopeError('read', null))
    act(() => errors().setScopeError('model', null))
    expect(errors().error).toBe('Could not update')

    act(() => errors().clearErrors())
    expect(errors().error).toBeNull()
    expect(errors().errors).toEqual([])
  })

  it('lists a message shared by two scopes once', () => {
    const errors = mountHook(useVoiceScopedErrors)
    act(() => errors().setScopeError('config', 'Desktop offline'))
    act(() => errors().setScopeError('key', 'Desktop offline'))
    expect(errors().errors).toEqual(['Desktop offline'])
  })
})

describe('voice controllers keep write errors across reads', () => {
  it('keeps a failed configure error after its follow-up refresh succeeds', async () => {
    const { operations, providerOps } = voiceOperations({})
    operations.configure = vi.fn().mockRejectedValue(new Error('Desktop refused the change'))
    const controller = await mountController(useVoiceSettingsController, operations)
    expect(controller().cabinet).not.toBeNull()

    await act(async () => controller().configure({ enabled: false }))
    expect(providerOps.list).toHaveBeenCalledTimes(2)
    expect(controller().error).toBe('Desktop refused the change')
  })

  it('keeps a config failure when a concurrent model download succeeds', async () => {
    const { operations } = voiceOperations({})
    operations.configure = vi.fn().mockRejectedValue(new Error('Could not switch model'))
    operations.download = vi.fn().mockResolvedValue(undefined)
    const controller = await mountController(useVoiceSettingsController, operations)

    await act(async () => controller().selectModel('whisper-tiny'))
    await act(async () => controller().downloadModel('parakeet'))
    expect(controller().error).toBe('Could not switch model')
  })

  it('keeps a key removal error after the provider list refreshes', async () => {
    const list = vi.fn().mockResolvedValue(cabinetState())
    const { operations } = voiceOperations({
      list,
      clearKey: vi.fn().mockRejectedValue(new Error('Keychain locked'))
    })
    const controller = await mountController(useVoiceProviderController, operations)

    await act(async () => controller().removeKey('soniox'))
    await act(async () => controller().deleteModel('whisper-tiny'))
    expect(list).toHaveBeenCalledTimes(2)
    expect(controller().error).toBe('Keychain locked')
  })
})

describe('voice controllers clear superseded errors after a successful write', () => {
  it('clears a key removal error once a later key save succeeds', async () => {
    const { operations } = voiceOperations({
      clearKey: vi.fn().mockRejectedValue(new Error('Keychain locked'))
    })
    const controller = await mountController(useVoiceProviderController, operations)

    await act(async () => controller().removeKey('soniox'))
    expect(controller().error).toBe('Keychain locked')
    await act(async () => controller().saveKey('soniox', 'new-key'))
    expect(controller().error).toBeNull()
  })

  it('clears a read error when a write snapshot reaches the provider screen', async () => {
    const { operations } = voiceOperations({
      list: vi.fn().mockRejectedValue(new Error('Desktop unreachable'))
    })
    const controller = await mountController(useVoiceProviderController, operations)
    expect(controller().error).toBe('Desktop unreachable')

    await act(async () => controller().saveKey('soniox', 'new-key'))
    expect(controller().state).not.toBeNull()
    expect(controller().error).toBeNull()
  })

  it('clears a read error when a write snapshot reaches the settings screen', async () => {
    const { operations } = voiceOperations({
      list: vi.fn().mockRejectedValue(new Error('Desktop unreachable'))
    })
    const controller = await mountController(useVoiceSettingsController, operations)
    expect(controller().error).toBe('Desktop unreachable')

    await act(async () => controller().configure({ enabled: false }))
    expect(controller().setup).not.toBeNull()
    expect(controller().error).toBeNull()
  })
})
