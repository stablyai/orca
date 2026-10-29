/**
 * Device diagnosis of WSL panes: console output is not kept on a packaged build, so each line
 * also goes to the local trace file (main.trace.ndjson, kept unless diagnostics are turned off).
 */
import { startSpan } from '../observability/tracer'

/** `trace` is the persisted line, so it must carry no paths or distro names. */
export function logWslPaneDiagnostic(
  name: 'wsl.sleep-folder' | 'wsl.bridge-exit',
  line: { console: string; trace: string },
  attributes: Record<string, string | number | boolean | null>
): void {
  console.info(line.console)
  try {
    startSpan(name, { attributes: { line: line.trace, ...attributes } }).end()
  } catch {
    // Optional diagnostics must never fail a Sleep or an exit.
  }
}
