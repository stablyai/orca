import { EventEmitter } from 'node:events'
import type { Rectangle, Session, View, WebContents, WebContentsView } from 'electron'
import { DesktopOwnedBrowserViewAdmission } from './desktop-owned-browser-view-admission'
import { DesktopOwnedBrowserView } from './desktop-owned-browser-view'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

export function createOwnedViewHost() {
  const children: View[] = []
  const host = {
    destroyed: false,
    rejectAttach: false,
    isDestroyed: () => host.destroyed,
    contentView: {
      children,
      addChildView: (view: View) => {
        if (host.rejectAttach) {
          throw new Error('fixture attach failure')
        }
        children.push(view)
      },
      removeChildView: (view: View) => {
        const index = children.indexOf(view)
        if (index !== -1) {
          children.splice(index, 1)
        }
      }
    }
  }
  return host
}

export function createOwnedViewFixture({ autoDestroy = true, visible = true } = {}) {
  class GuestFixture extends EventEmitter {
    readonly id = 41
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture compares Session identity without calling Session APIs.
    session = {} as Session
    destroyed = false
    closeCalls = 0
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      this.closeCalls += 1
      if (autoDestroy) {
        this.finishClose()
      }
    }
    finishClose(): void {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  const guest = new GuestFixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller and admission only use the fixture's identity, Session and close/event APIs.
  const webContents = guest as unknown as WebContents
  const state = { bounds: { x: 4, y: 40, width: 1152, height: 642 }, visible }
  const boundsHistory: Rectangle[] = []
  const viewShape = {
    webContents,
    getBounds: () => ({ ...state.bounds }),
    setBounds: (bounds: Rectangle) => {
      state.bounds = { ...bounds }
      boundsHistory.push({ ...bounds })
    },
    getVisible: () => state.visible,
    setVisible: (next: boolean) => {
      state.visible = next
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle uses only the view's contents, bounds and visibility APIs supplied here.
  const view = viewShape as unknown as WebContentsView
  const admission = new DesktopOwnedBrowserViewAdmission({
    isKnownPartition: () => 'persist:fixture',
    getSession: () => guest.session,
    createView: () => view,
    attachPolicies: () => {}
  })
  const record = admission.create({
    browserPageId: 'page',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    sessionProfileId: 'profile',
    rendererWebContentsId: 8
  })
  const host = createOwnedViewHost()
  host.contentView.addChildView(view)
  const controller = new DesktopOwnedBrowserView(record, host)
  return { guest, view, record, host, controller, state, boundsHistory }
}
