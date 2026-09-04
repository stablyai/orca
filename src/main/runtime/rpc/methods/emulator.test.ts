import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { EMULATOR_METHODS } from './emulator'

// Why: importing the RpcDispatcher (like sibling browser.test.ts) pulls in
// ALL_RPC_METHODS, which transitively reaches modules that require a real
// Electron binary at import time. This file only needs EMULATOR_METHODS'
// schemas + handlers, so it drives them directly (safeParse + handler call)
// instead of round-tripping through the dispatcher.

function method(name: string) {
  const found = EMULATOR_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not registered: ${name}`)
  }
  return found
}

function ctx(runtime: Partial<OrcaRuntimeService>): RpcContext {
  return { runtime: runtime as OrcaRuntimeService }
}

const STATUS = { state: 'connected', address: '10.0.0.5:5555', serial: '10.0.0.5:5555' }

describe('emulator.adbConnect schema', () => {
  it('rejects a missing address', () => {
    const result = method('emulator.adbConnect').params!.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects an empty address', () => {
    const result = method('emulator.adbConnect').params!.safeParse({ address: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a non-string address instead of coercing it', () => {
    const result = method('emulator.adbConnect').params!.safeParse({ address: 5555 })
    expect(result.success).toBe(false)
  })

  it('accepts an address with an optional worktree', () => {
    const result = method('emulator.adbConnect').params!.safeParse({
      address: '10.0.0.5:5555',
      worktree: 'id:wt-1'
    })
    expect(result.success).toBe(true)
  })
})

describe('emulator.adbDisconnect / emulator.adbConnectionStatus schemas', () => {
  it('accept an omitted address', () => {
    expect(method('emulator.adbDisconnect').params!.safeParse({}).success).toBe(true)
    expect(method('emulator.adbConnectionStatus').params!.safeParse({}).success).toBe(true)
  })

  it('reject an explicit but empty address (optional means omitted, not blank)', () => {
    expect(method('emulator.adbDisconnect').params!.safeParse({ address: '' }).success).toBe(false)
    expect(method('emulator.adbConnectionStatus').params!.safeParse({ address: '' }).success).toBe(
      false
    )
  })

  it('accept an explicit address', () => {
    expect(
      method('emulator.adbDisconnect').params!.safeParse({ address: '10.0.0.5:5555' }).success
    ).toBe(true)
    expect(
      method('emulator.adbConnectionStatus').params!.safeParse({ address: '10.0.0.5:5555' }).success
    ).toBe(true)
  })
})

describe('emulator ADB RPC handlers delegate to the runtime', () => {
  it('emulator.adbConnect calls runtime.emulatorAdbConnect with the validated params', async () => {
    const emulatorAdbConnect = vi.fn().mockResolvedValue(STATUS)
    const params = method('emulator.adbConnect').params!.parse({
      address: '10.0.0.5:5555',
      worktree: 'id:wt-1'
    })

    const result = await method('emulator.adbConnect').handler(params, ctx({ emulatorAdbConnect }))

    expect(emulatorAdbConnect).toHaveBeenCalledWith({
      address: '10.0.0.5:5555',
      worktree: 'id:wt-1'
    })
    expect(result).toBe(STATUS)
  })

  it('emulator.adbDisconnect calls runtime.emulatorAdbDisconnect, address included', async () => {
    const emulatorAdbDisconnect = vi.fn().mockResolvedValue({ ...STATUS, state: 'disconnected' })
    const params = method('emulator.adbDisconnect').params!.parse({ address: '10.0.0.5:5555' })

    await method('emulator.adbDisconnect').handler(params, ctx({ emulatorAdbDisconnect }))

    expect(emulatorAdbDisconnect).toHaveBeenCalledWith({ address: '10.0.0.5:5555' })
  })

  it('emulator.adbDisconnect calls runtime.emulatorAdbDisconnect with no address when omitted', async () => {
    const emulatorAdbDisconnect = vi
      .fn()
      .mockResolvedValue({ state: 'disconnected', address: null, serial: null })
    const params = method('emulator.adbDisconnect').params!.parse({})

    await method('emulator.adbDisconnect').handler(params, ctx({ emulatorAdbDisconnect }))

    expect(emulatorAdbDisconnect).toHaveBeenCalledWith({})
  })

  it('emulator.adbConnectionStatus calls runtime.emulatorAdbConnectionStatus, address included', async () => {
    const emulatorAdbConnectionStatus = vi.fn().mockResolvedValue(STATUS)
    const params = method('emulator.adbConnectionStatus').params!.parse({
      address: '10.0.0.5:5555'
    })

    const result = await method('emulator.adbConnectionStatus').handler(
      params,
      ctx({ emulatorAdbConnectionStatus })
    )

    expect(emulatorAdbConnectionStatus).toHaveBeenCalledWith({ address: '10.0.0.5:5555' })
    expect(result).toBe(STATUS)
  })
})
