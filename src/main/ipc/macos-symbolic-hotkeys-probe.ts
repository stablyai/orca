import { ipcMain } from 'electron'
import {
  capturedDigitRowChordsFromSymbolicHotkeysJson,
  type MacCapturedDigitRowChord
} from '../../shared/macos-symbolic-hotkeys'

// Export live preferences; the plist may be stale.
const MAC_SYMBOLIC_HOTKEYS_JSON_COMMAND = [
  '/usr/bin/defaults export com.apple.symbolichotkeys -',
  '/usr/bin/plutil -convert json -o - -'
].join(' | ')

type ReadCommandStdout = (
  command: string,
  args: string[],
  timeoutMessage: string
) => Promise<string>

// Mission Control intercepts these chords before renderer delivery.
export function registerMacSymbolicHotkeysProbeHandler(readCommandStdout: ReadCommandStdout): void {
  ipcMain.handle(
    'app:getMacCapturedDigitRowChords',
    async (): Promise<MacCapturedDigitRowChord[]> => {
      if (process.platform !== 'darwin') {
        return []
      }
      try {
        const stdout = await readCommandStdout(
          '/bin/sh',
          ['-c', MAC_SYMBOLIC_HOTKEYS_JSON_COMMAND],
          'Symbolic hotkeys probe timed out'
        )
        return capturedDigitRowChordsFromSymbolicHotkeysJson(JSON.parse(stdout))
      } catch {
        return []
      }
    }
  )
}
