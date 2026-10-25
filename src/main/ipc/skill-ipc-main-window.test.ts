import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

import { handleMainWindowSkillIpc } from './skill-ipc-main-window'
import { sendSkillInstallProgress } from './skill-install-progress-ipc'
import {
  registerDesktopRenderer,
  setDesktopRendererFocusResolver,
  unregisterDesktopRenderer
} from '../window/desktop-renderer-registry'

const instances = new Set<Renderer>()
class Renderer extends EventEmitter {
  private destroyed = false
  readonly send = vi.fn()
  constructor(
    readonly id: number,
    private readonly kind = 'window'
  ) {
    super()
    instances.add(this)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getType(): string {
    return this.kind
  }
  getURL(): string {
    return 'file:///renderer/index.html'
  }
  contents(): WebContents {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registry and progress delivery use only the fixture's identity, events, type, lifetime and send methods.
    return this as unknown as WebContents
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function invoke(sender: Renderer): unknown {
  const handler: unknown = handleMock.mock.calls.at(-1)?.[1]
  if (typeof handler !== 'function') {
    throw new Error('No skill IPC handler')
  }
  return handler({ sender: sender.contents() }, 'value')
}

beforeEach(() => {
  handleMock.mockReset()
})
afterEach(() => {
  for (const renderer of instances) {
    unregisterDesktopRenderer(renderer.contents())
  }
  instances.clear()
  setDesktopRendererFocusResolver(null)
})

describe('native desktop skill IPC', () => {
  it('accepts both exact registered peers while one is preferred, then survives first close', () => {
    const first = new Renderer(1)
    const second = new Renderer(2)
    registerDesktopRenderer(first.contents(), 'desktop-0')
    registerDesktopRenderer(second.contents(), 'desktop-1')
    setDesktopRendererFocusResolver(() => first.contents())
    const listener = vi.fn(() => 'ok')
    handleMainWindowSkillIpc('skills:test', listener)
    expect(invoke(first)).toBe('ok')
    expect(invoke(second)).toBe('ok')
    first.destroy()
    expect(invoke(second)).toBe('ok')
    expect(() => invoke(first)).toThrow('Unauthorized skill IPC sender')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it.each([
    'dashboard pop-out',
    'foreign file window',
    'webview',
    'destroyed',
    'unregistered',
    'same numeric id'
  ])('rejects %s before invoking skill code', (kind) => {
    const registered = new Renderer(1)
    registerDesktopRenderer(registered.contents(), 'desktop-0')
    const sender = new Renderer(
      kind === 'same numeric id' ? 1 : 2,
      kind === 'webview' ? 'webview' : 'window'
    )
    if (['webview', 'destroyed', 'unregistered'].includes(kind)) {
      registerDesktopRenderer(sender.contents(), 'desktop-1')
    }
    if (kind === 'destroyed') {
      sender.destroy()
    }
    if (kind === 'unregistered') {
      unregisterDesktopRenderer(sender.contents())
    }
    const listener = vi.fn()
    handleMainWindowSkillIpc('skills:test', listener)
    expect(() => invoke(sender)).toThrow('Unauthorized skill IPC sender')
    expect(listener).not.toHaveBeenCalled()
  })

  it('refuses an unregistered file window when no desktop survives', () => {
    const sender = new Renderer(3)
    handleMainWindowSkillIpc('skills:test', vi.fn())
    expect(() => invoke(sender)).toThrow('Unauthorized skill IPC sender')
  })

  it('keeps progress on the requesting peer even when another renderer is preferred', () => {
    const first = new Renderer(1)
    const second = new Renderer(2)
    registerDesktopRenderer(first.contents(), 'desktop-0')
    registerDesktopRenderer(second.contents(), 'desktop-1')
    setDesktopRendererFocusResolver(() => first.contents())
    handleMainWindowSkillIpc('skills:test', (event: IpcMainInvokeEvent) => {
      sendSkillInstallProgress(event, { operationId: 'peer-install', phase: 'authorizing' })
      return 'ok'
    })
    expect(invoke(second)).toBe('ok')
    expect(second.send).toHaveBeenCalledExactlyOnceWith('skills:installProgress', {
      operationId: 'peer-install',
      phase: 'authorizing'
    })
    expect(first.send).not.toHaveBeenCalled()
  })
})
