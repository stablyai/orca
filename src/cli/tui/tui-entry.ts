import { TuiScreenController } from './tui-screen-controller'
import { ALT_SCREEN_LEAVE, AUTOWRAP_ON, SHOW_CURSOR } from './ansi-control'
import { MOUSE_DISABLE } from './mouse-input'
import type { RunTuiOptions } from './tui-runtime-contract'

/** Bundled entry point. The CommonJS handler requires the esbuild output and
 *  calls this; the controller owns the terminal directly (alt screen, raw mode,
 *  mouse, the diff compositor) and resolves only when the user quits. */
export async function runTui(options: RunTuiOptions): Promise<void> {
  const controller = new TuiScreenController(options)
  try {
    await controller.run()
  } finally {
    // Defensive restore: the controller already tears down on a clean quit, but
    // on a thrown error make sure we never strand the user in the alt screen.
    const leave = options.noAltScreen ? '' : ALT_SCREEN_LEAVE
    process.stdout.write(SHOW_CURSOR + MOUSE_DISABLE + AUTOWRAP_ON + leave)
  }
}
