// Ambient state augmentation required by Claude's plugin manifest (.d.ts only).

declare module 'claude-code' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Module augmentation requires an interface.
  interface PluginState {
    /** By the block as written (a fence, a `$$` formula, an image line); a `Failure` is one that did not render. */
    'reply-media': {
      diagrams: Record<
        string,
        | {
            file: string
            width: number
            height: number
            path?: string
            clip?: string
            frames?: { dir: string; count: number; fps: number }
          }
        | { error: string }
      >
      /** The block whose picture the zoom pane shows; `null` before any was zoomed. */
      zoomed: string | null
      /** The block of the video that is playing; `null` when none is. */
      playing: string | null
      /** The clip being prepared; pressing its button again cancels playback. */
      preparing: string | null
    }
  }
}
