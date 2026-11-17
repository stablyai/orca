import { dirname, join } from 'node:path'
import { ZOTZ_APP_ID } from '../../shared/zotz/zotz-app-identity'
import { ZOTZ_NODE_AUTOSTART_ARG } from '../../shared/zotz/zotz-node-setup-contract'
import {
  renderZotzWindowsScheduledTaskXml,
  zotzWindowsTaskPath
} from '../../shared/zotz/zotz-windows-scheduled-task'

/** The desktop app (not headless serve) is what the OS keeps alive in server mode. */
export const ZOTZ_SERVER_TASK_PATH = zotzWindowsTaskPath('Server')
export const ZOTZ_SERVER_LAUNCHD_LABEL = `${ZOTZ_APP_ID}.server`
export const ZOTZ_SERVER_SYSTEMD_UNIT = 'zotz-server.service'

export type ZotzDesktopAutostartSpec = { path: string; content: string }

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** systemd unescapes quotes and backslashes and expands `%` specifiers. */
function systemdArgument(value: string): string {
  const escaped = value.replace(/%/g, '%%')
  return /[\s"'\\;$]/.test(escaped)
    ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : escaped
}

export function renderZotzDesktopAutostart(input: {
  platform: NodeJS.Platform
  executablePath: string
  homeDir: string
  userDataPath: string
  windowsUserId: string
}): ZotzDesktopAutostartSpec | null {
  const argv = [input.executablePath, ZOTZ_NODE_AUTOSTART_ARG]
  if (input.platform === 'win32') {
    return {
      path: join(input.userDataPath, 'zotz-server-task.xml'),
      content: renderZotzWindowsScheduledTaskXml({
        taskPath: ZOTZ_SERVER_TASK_PATH,
        userId: input.windowsUserId,
        command: input.executablePath,
        args: [ZOTZ_NODE_AUTOSTART_ARG],
        workingDirectory: dirname(input.executablePath),
        description: 'Zotz in server mode: starts at logon and comes back if it stops.'
      })
    }
  }
  if (input.platform === 'darwin') {
    const strings = argv.map((value) => `    <string>${xmlText(value)}</string>`).join('\n')
    // KeepAlive only after a crash: quitting Zotz on purpose stays quit until the next login.
    return {
      path: join(input.homeDir, 'Library', 'LaunchAgents', `${ZOTZ_SERVER_LAUNCHD_LABEL}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ZOTZ_SERVER_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`
    }
  }
  if (input.platform === 'linux') {
    // A GUI app needs the graphical session's DISPLAY/WAYLAND_DISPLAY, so it hangs off that target.
    return {
      path: join(input.homeDir, '.config', 'systemd', 'user', ZOTZ_SERVER_SYSTEMD_UNIT),
      content: `[Unit]
Description=Zotz in server mode
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${argv.map(systemdArgument).join(' ')}
Restart=on-failure
RestartSec=60

[Install]
WantedBy=graphical-session.target
`
    }
  }
  return null
}
