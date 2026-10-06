import type { WebContents } from 'electron'
import type { TerminalPreviewOutputStream } from './terminal-preview-output-stream'

const SURFACE_ID_MAX_LENGTH = 256

// Why: renderers that predate per-surface previews send no surfaceId; they get
// one implicit surface per pty, which keeps their connect-replaces-connect flow.
const IMPLICIT_SURFACE_ID = ''

export function previewSurfaceIdOf(value: unknown): string | null {
  if (value === undefined) {
    return IMPLICIT_SURFACE_ID
  }
  return typeof value === 'string' && value.length > 0 && value.length <= SURFACE_ID_MAX_LENGTH
    ? value
    : null
}

/**
 * The preview streams and grid claims one webContents holds, keyed by pty and
 * surface. One webContents can show the same pty on two surfaces at once (a
 * session grid card and the dialog it opens): each surface owns its own
 * stream, snapshot boundary and grid claim, so releasing one surface hands the
 * pty to whichever surface is still watching it, not back to the host pane.
 */
export class TerminalPreviewSurfaceRegistry {
  private readonly streamsByContents = new Map<
    number,
    Map<string, Map<string, TerminalPreviewOutputStream>>
  >()
  // Why: the preview dialog claims the PTY grid through the remote-desktop
  // viewer registry so the main-window pane parks and later reclaims its own
  // geometry. Claims are tracked per viewer webContents and surface so an
  // explicit unsubscribe or a destroyed window always releases the size floor,
  // and each surface releases only its own viewer.
  private readonly claimsByContents = new Map<number, Map<string, Map<string, symbol>>>()

  constructor(
    private readonly releaseViewer: (contentsId: number, ptyId: string, surfaceId: string) => void
  ) {}

  /** Registers the destroyed hook on first sight of a webContents. */
  observe(contents: WebContents): void {
    if (!this.streamsByContents.has(contents.id)) {
      this.streamsByContents.set(contents.id, new Map())
      contents.once('destroyed', () => this.disposeContents(contents.id))
    }
  }

  stream(
    contentsId: number,
    ptyId: string,
    surfaceId: string
  ): TerminalPreviewOutputStream | undefined {
    return this.streamsByContents.get(contentsId)?.get(ptyId)?.get(surfaceId)
  }

  /** Replaces (disposing) any stream the same surface already had for the pty. */
  setStream(stream: TerminalPreviewOutputStream): void {
    this.observe(stream.contents)
    const perPty = this.streamsByContents.get(stream.contents.id)!
    let surfaces = perPty.get(stream.ptyId)
    if (!surfaces) {
      surfaces = new Map()
      perPty.set(stream.ptyId, surfaces)
    }
    surfaces.set(stream.surfaceId, stream)
  }

  removeStream(stream: TerminalPreviewOutputStream): void {
    const perPty = this.streamsByContents.get(stream.contents.id)
    const surfaces = perPty?.get(stream.ptyId)
    if (surfaces?.get(stream.surfaceId) === stream) {
      surfaces.delete(stream.surfaceId)
      if (surfaces.size === 0) {
        perPty!.delete(stream.ptyId)
      }
    }
  }

  /** Records a surface's claim; the returned token proves it is still the newest. */
  claim(contentsId: number, ptyId: string, surfaceId: string): symbol {
    let claimed = this.claimsByContents.get(contentsId)
    if (!claimed) {
      claimed = new Map()
      this.claimsByContents.set(contentsId, claimed)
    }
    let surfaces = claimed.get(ptyId)
    if (!surfaces) {
      surfaces = new Map()
      claimed.set(ptyId, surfaces)
    }
    const token = Symbol('terminal-preview-fit')
    surfaces.set(surfaceId, token)
    return token
  }

  holdsClaim(contentsId: number, ptyId: string, surfaceId: string, token: symbol): boolean {
    return this.claimsByContents.get(contentsId)?.get(ptyId)?.get(surfaceId) === token
  }

  releaseClaim(contentsId: number, ptyId: string, surfaceId: string): void {
    const claimed = this.claimsByContents.get(contentsId)
    const surfaces = claimed?.get(ptyId)
    if (!surfaces?.delete(surfaceId)) {
      return
    }
    if (surfaces.size === 0) {
      claimed!.delete(ptyId)
      if (claimed!.size === 0) {
        this.claimsByContents.delete(contentsId)
      }
    }
    this.releaseViewer(contentsId, ptyId, surfaceId)
  }

  private disposeContents(contentsId: number): void {
    const perPty = this.streamsByContents.get(contentsId)
    if (perPty) {
      for (const surfaces of perPty.values()) {
        for (const stream of surfaces.values()) {
          stream.dispose()
        }
      }
      this.streamsByContents.delete(contentsId)
    }
    // Why copied: releasing one claim mutates these maps while the remaining claims still need teardown.
    for (const [ptyId, surfaces] of Array.from(this.claimsByContents.get(contentsId) ?? [])) {
      for (const surfaceId of Array.from(surfaces.keys())) {
        this.releaseClaim(contentsId, ptyId, surfaceId)
      }
    }
  }
}
