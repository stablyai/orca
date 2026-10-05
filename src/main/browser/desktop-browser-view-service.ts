import type { BrowserWindow, View, WebContents } from 'electron'
import type {
  DesktopBrowserViewCapture,
  DesktopBrowserViewCommandArgs,
  DesktopBrowserViewCommandResult,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewEvent,
  DesktopBrowserViewIdentity,
  DesktopBrowserViewInputArgs,
  DesktopBrowserViewLayout,
  DesktopBrowserViewState
} from '../../shared/desktop-browser-view-protocol'
import { browserCaptureIdle } from './browser-capture-idle'
import type { BrowserManager } from './browser-manager'
import {
  DesktopOwnedBrowserViewAdmissionError,
  type DesktopOwnedBrowserViewAdmission,
  type DesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'
import { DesktopOwnedBrowserView } from './desktop-owned-browser-view'
import { observeDesktopBrowserView } from './desktop-browser-view-state'
import {
  executeDesktopBrowserViewCommand,
  navigateDesktopBrowserView
} from './desktop-browser-view-command'
import { isWorkspaceDocPageId } from './doc-preview-guest-policy'
import { DesktopBrowserViewAttachment } from './desktop-browser-view-attachment'
import { dispatchDesktopBrowserViewInput } from './desktop-browser-view-input'
import { DesktopBrowserViewInputState } from './desktop-browser-view-input-state'

type ViewEntry = {
  record: DesktopOwnedBrowserViewRecord
  controller: DesktopOwnedBrowserView
  owner: BrowserWindow
  attachment: DesktopBrowserViewAttachment
  observer: ReturnType<typeof observeDesktopBrowserView>
  disposeOwner: () => void
  disposeRegistration: () => void | Promise<void>
  closePromise: Promise<void> | null
  visible: boolean
  inputEnabled: boolean
  inputState: DesktopBrowserViewInputState
}

export type DesktopBrowserViewServiceDependencies = {
  admission: DesktopOwnedBrowserViewAdmission
  manager: Pick<BrowserManager, 'getGuestWebContentsId' | 'registerOwnedView' | 'unregisterGuest'>
  resolveOwner: (sender: WebContents) => BrowserWindow | null
  createContainer: () => View
  publish: (sender: WebContents, event: DesktopBrowserViewEvent) => void
  onRegistered: (
    record: DesktopOwnedBrowserViewRecord,
    controller: DesktopOwnedBrowserView,
    owner: BrowserWindow
  ) => void | (() => void | Promise<void>)
  retirePage: (record: DesktopOwnedBrowserViewRecord) => Promise<void>
  captureViewport: (record: DesktopOwnedBrowserViewRecord) => Promise<DesktopBrowserViewCapture>
  onError: (error: unknown) => void
}

export class DesktopBrowserViewService {
  private readonly entries = new Map<string, ViewEntry>()
  private readonly creating = new Set<string>()

  constructor(private readonly dependencies: DesktopBrowserViewServiceDependencies) {}

  async create(
    sender: WebContents,
    args: DesktopBrowserViewCreateArgs
  ): Promise<DesktopBrowserViewState> {
    const { manager, admission, resolveOwner } = this.dependencies
    if (
      isWorkspaceDocPageId(args.browserPageId) ||
      this.creating.has(args.browserPageId) ||
      this.entries.has(args.browserPageId) ||
      manager.getGuestWebContentsId(args.browserPageId) !== null
    ) {
      throw new Error('Desktop browser page already exists or is reserved')
    }
    const owner = resolveOwner(sender)
    if (!owner || owner.isDestroyed() || sender.isDestroyed() || owner.webContents !== sender) {
      throw new Error('Desktop browser renderer has no current owning window')
    }
    this.creating.add(args.browserPageId)
    let record: DesktopOwnedBrowserViewRecord | null = null
    let attachment: DesktopBrowserViewAttachment | null = null
    let registered = false
    try {
      record = admission.create({ ...args, rendererWebContentsId: sender.id })
      attachment = new DesktopBrowserViewAttachment(
        record,
        owner,
        this.dependencies.createContainer()
      )
      attachment.attach()
      const controller = new DesktopOwnedBrowserView(record, attachment.host)
      registered = manager.registerOwnedView(record, owner, attachment.container)
      if (!registered) {
        throw new Error('Desktop browser view registration was refused')
      }
      const webContents = record.webContents
      const entry: ViewEntry = {
        record,
        controller,
        owner,
        attachment,
        observer: observeDesktopBrowserView(
          record,
          (event) => this.dependencies.publish(sender, event),
          () => this.retireUnexpectedly(args.browserPageId)
        ),
        disposeOwner: () => {},
        disposeRegistration: () => {},
        closePromise: null,
        visible: false,
        inputEnabled: false,
        inputState: new DesktopBrowserViewInputState((input) =>
          dispatchDesktopBrowserViewInput(webContents, input)
        )
      }
      this.entries.set(args.browserPageId, entry)
      entry.disposeOwner = this.observeOwner(sender, entry)
      entry.disposeRegistration =
        this.dependencies.onRegistered(record, controller, owner) ?? (() => {})
      navigateDesktopBrowserView(record.webContents, args.url)
      return entry.observer.read()
    } catch (error) {
      if (error instanceof DesktopOwnedBrowserViewAdmissionError) {
        await error.cleanup
      }
      if (record) {
        const entry = this.entries.get(args.browserPageId)
        if (entry?.record === record) {
          await this.closeEntry(entry)
        } else {
          await this.closeRejected(record, attachment)
          if (
            registered &&
            manager.getGuestWebContentsId(args.browserPageId) === record.webContents.id
          ) {
            manager.unregisterGuest(args.browserPageId)
          }
        }
      }
      throw error
    } finally {
      this.creating.delete(args.browserPageId)
    }
  }

  async updateLayout(sender: WebContents, args: DesktopBrowserViewLayout): Promise<void> {
    const entry = this.requireEntry(sender, args)
    await entry.controller.withStableView(async () => {
      entry.visible = entry.attachment.update(args, sender.getZoomFactor())
      entry.inputEnabled = !args.inputLocked && (entry.visible || args.forwardInput === true)
      if (!entry.inputEnabled) {
        await entry.inputState.releaseAll()
      }
    })
  }

  async command(
    sender: WebContents,
    args: DesktopBrowserViewCommandArgs
  ): Promise<DesktopBrowserViewCommandResult> {
    const entry = this.requireEntry(sender, args)
    return entry.controller.withStableView(() =>
      executeDesktopBrowserViewCommand({
        guest: entry.record.webContents,
        owner: sender,
        command: args.command,
        inputAvailable: entry.visible,
        read: entry.observer.read
      })
    )
  }

  async input(sender: WebContents, args: DesktopBrowserViewInputArgs): Promise<void> {
    const entry = this.requireEntry(sender, args)
    await entry.controller.withStableView(async () => {
      await entry.inputState.dispatch(args.input, entry.inputEnabled)
    })
  }

  close(sender: WebContents, identity: DesktopBrowserViewIdentity): Promise<void> {
    const entry = this.requireEntry(sender, identity, true)
    return this.closeEntry(entry)
  }

  async captureViewport(
    sender: WebContents,
    identity: DesktopBrowserViewIdentity
  ): Promise<DesktopBrowserViewCapture> {
    const entry = this.requireEntry(sender, identity)
    return this.dependencies.captureViewport(entry.record)
  }

  private requireEntry(
    sender: WebContents,
    identity: DesktopBrowserViewIdentity,
    closing = false
  ): ViewEntry {
    const entry = this.entries.get(identity.browserPageId)
    if (
      !entry ||
      sender.isDestroyed() ||
      entry.record.rendererWebContentsId !== sender.id ||
      entry.record.generation !== identity.generation ||
      (!closing &&
        (entry.closePromise ||
          !entry.controller.validate(identity.browserPageId, sender.id, identity.generation)))
    ) {
      throw new Error('Desktop browser view identity is stale or unavailable')
    }
    return entry
  }

  private closeEntry(entry: ViewEntry): Promise<void> {
    if (!entry.closePromise) {
      entry.closePromise = this.retireEntry(entry)
      void entry.closePromise.catch((error) => {
        entry.closePromise = null
        this.dependencies.onError(error)
      })
    }
    return entry.closePromise
  }

  private async retireEntry(entry: ViewEntry): Promise<void> {
    await entry.controller.close(() => this.dependencies.retirePage(entry.record))
    entry.attachment.detach()
    await entry.disposeRegistration()
    entry.disposeOwner()
    entry.observer.dispose()
    const { manager } = this.dependencies
    if (manager.getGuestWebContentsId(entry.record.browserPageId) === entry.record.webContents.id) {
      manager.unregisterGuest(entry.record.browserPageId)
    }
    if (this.entries.get(entry.record.browserPageId) === entry) {
      this.entries.delete(entry.record.browserPageId)
    }
  }

  private retireUnexpectedly(pageId: string): void {
    const entry = this.entries.get(pageId)
    if (entry) {
      void this.closeEntry(entry)
    }
  }

  private observeOwner(sender: WebContents, entry: ViewEntry): () => void {
    const retire = (): void => {
      void this.closeEntry(entry)
    }
    const navigation = (
      details: Electron.Event & { isMainFrame: boolean; isSameDocument: boolean }
    ): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        retire()
      }
    }
    sender.once('destroyed', retire)
    sender.on('render-process-gone', retire)
    sender.on('did-start-navigation', navigation)
    return () => {
      sender.removeListener('destroyed', retire)
      sender.removeListener('render-process-gone', retire)
      sender.removeListener('did-start-navigation', navigation)
    }
  }

  private async closeRejected(
    record: DesktopOwnedBrowserViewRecord,
    attachment: DesktopBrowserViewAttachment | null
  ): Promise<void> {
    await browserCaptureIdle.waitForIdle(record.webContents)
    attachment?.detach()
    if (!record.webContents.isDestroyed()) {
      await new Promise<void>((resolve) => {
        record.webContents.once('destroyed', resolve)
        record.webContents.close()
      })
    }
  }
}
