/** Pure rendering of the per-user service units `orca serve service install` writes. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SERVE_LAUNCHD_LABEL_PREFIX } from '../../shared/serve-bundle-coordination'

export type ServeServiceManager = 'launchd' | 'systemd'

export type ServeServiceSpec = {
  manager: ServeServiceManager
  /** launchd label or systemd unit name (with `.service`). */
  name: string
  unitPath: string
  logPath: string | null
  content: string
}

export type ServeServiceInput = {
  platform: NodeJS.Platform
  homeDir: string
  /** Absolute path of the stable `orca` launcher, never a version-specific executable. */
  command: string
  userDataPath: string
  /** The profile's userData when no override is set; that profile gets the plain name. */
  defaultUserDataPath: string
  path: string
  port?: string | null
  pairingAddress?: string | null
}

/** Why `--no-pairing`: a service's output lands in a log, which must never hold a live offer. */
export function serveServiceArgs(
  input: Pick<ServeServiceInput, 'port' | 'pairingAddress'>
): string[] {
  return [
    'serve',
    '--supervise',
    '--no-pairing',
    ...(input.port ? ['--port', input.port] : []),
    ...(input.pairingAddress ? ['--pairing-address', input.pairingAddress] : [])
  ]
}

function profileSuffix(input: ServeServiceInput): string {
  return input.userDataPath === input.defaultUserDataPath
    ? ''
    : createHash('sha256').update(input.userDataPath).digest('hex').slice(0, 8)
}

export function resolveServeServiceManager(platform: NodeJS.Platform): ServeServiceManager | null {
  return platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null
}

export function renderServeService(input: ServeServiceInput): ServeServiceSpec {
  const manager = resolveServeServiceManager(input.platform)
  if (!manager) {
    throw new Error(`No service manager support on ${input.platform}`)
  }
  const suffix = profileSuffix(input)
  // Why always pin: the manager's environment may resolve a different default profile.
  const env: Record<string, string> = { PATH: input.path, ORCA_USER_DATA_PATH: input.userDataPath }
  const argv = [input.command, ...serveServiceArgs(input)]
  if (manager === 'launchd') {
    const name = suffix ? `${SERVE_LAUNCHD_LABEL_PREFIX}.${suffix}` : SERVE_LAUNCHD_LABEL_PREFIX
    const logPath = join(input.homeDir, 'Library', 'Logs', 'Orca', `${name}.log`)
    return {
      manager,
      name,
      unitPath: join(input.homeDir, 'Library', 'LaunchAgents', `${name}.plist`),
      logPath,
      content: renderLaunchAgent(name, argv, env, logPath)
    }
  }
  const name = suffix ? `orca-serve-${suffix}.service` : 'orca-serve.service'
  return {
    manager,
    name,
    unitPath: join(input.homeDir, '.config', 'systemd', 'user', name),
    logPath: null,
    content: renderSystemdUnit(argv, env)
  }
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderLaunchAgent(
  label: string,
  argv: string[],
  env: Record<string, string>,
  logPath: string
): string {
  const strings = (values: string[]): string =>
    values.map((value) => `    <string>${xml(value)}</string>`).join('\n')
  const envEntries = Object.entries(env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n')
  // Why KeepAlive on failure only: the supervisor exits 0 after its crash-loop brake gives up, and
  // launchd has no start-limit key, so a clean exit is the only way to make it stop.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(argv)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>90</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`
}

/** systemd's own quoting: double quotes, backslash escapes, and `%` doubled against specifiers. */
export function systemdQuote(value: string): string {
  const escaped = value.replace(/%/g, '%%')
  return /[\s"'\\;$]/.test(escaped)
    ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : escaped
}

function renderSystemdUnit(argv: string[], env: Record<string, string>): string {
  const environment = Object.entries(env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join('\n')
  // Why KillMode=process: stopping the service stops the supervisor, which stops its server; the
  // terminal daemon is designed to outlive the server, as it outlives the desktop app.
  return `[Unit]
Description=Orca server (orca serve --supervise)
StartLimitIntervalSec=900
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${argv.map(systemdQuote).join(' ')}
${environment}
Restart=on-failure
RestartSec=10
TimeoutStopSec=90
KillMode=process

[Install]
WantedBy=default.target
`
}
