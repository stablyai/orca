#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const checks = [
  {
    name: 'macOS Swift renderer/provider tests',
    command: 'swift',
    args: ['test', '--package-path', 'native/computer-use-macos'],
    enabled: process.platform === 'darwin'
  },
  {
    name: 'Linux provider Python syntax',
    command: 'python3',
    args: [
      '-c',
      [
        'import ast, pathlib',
        'source=pathlib.Path("native/computer-use-linux/runtime.py").read_text(encoding="utf-8")',
        'ast.parse(source)',
        'print("syntax-ok")'
      ].join(';')
    ],
    enabled: true
  },
  {
    name: 'native provider argument guardrails',
    run: verifyNativeArgumentGuardrails,
    enabled: true
  },
  {
    name: 'Linux provider imports',
    command: 'python3',
    args: [
      '-c',
      [
        'import importlib.util',
        'spec=importlib.util.spec_from_file_location("orca_linux","native/computer-use-linux/runtime.py")',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'print("import-ok")'
      ].join(';')
    ],
    enabled: process.platform === 'linux'
  },
  {
    name: 'Windows provider PowerShell parse',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      [
        '$errors=$null',
        '$tokens=$null',
        '[System.Management.Automation.Language.Parser]::ParseFile("native/computer-use-windows/runtime.ps1",[ref]$tokens,[ref]$errors) > $null',
        'if ($errors.Count) { $errors | Format-List *; exit 1 }',
        '"parse-ok"'
      ].join('; ')
    ],
    enabled: true
  },
  {
    name: 'Windows provider handshake',
    run: verifyWindowsProviderHandshake,
    enabled: process.platform === 'win32'
  },
  {
    name: 'macOS helper app bundle and signature',
    run: verifyMacOSHelperApp,
    enabled: process.platform === 'darwin'
  }
]

let failed = false
for (const check of checks) {
  if (!check.enabled) {
    console.log(`[computer-native] skip ${check.name}`)
    continue
  }
  if (check.run) {
    console.log(`[computer-native] ${check.name}`)
    if (!check.run()) {
      failed = true
    }
    continue
  }
  if (!hasCommand(check.command)) {
    console.log(`[computer-native] skip ${check.name}: ${check.command} not found`)
    continue
  }
  console.log(`[computer-native] ${check.name}`)
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'inherit'
  })
  if (result.status !== 0 || result.error) {
    failed = true
  }
}

if (failed) {
  process.exit(1)
}

function hasCommand(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { stdio: 'ignore' })
    return result.status === 0
  }
  if (existsSync(command)) {
    return true
  }
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${quoteShell(command)}`], {
    stdio: 'ignore'
  })
  return result.status === 0
}

function verifyMacOSHelperApp() {
  const appPath = join(
    repoRoot,
    'native',
    'computer-use-macos',
    '.build',
    'release',
    'Orca Computer Use.app'
  )
  if (!existsSync(appPath)) {
    console.error(
      `[computer-native] missing helper app at ${appPath}; run pnpm build:computer-macos`
    )
    return false
  }
  return run('codesign', ['--verify', '--deep', '--strict', appPath])
}

function verifyWindowsProviderHandshake() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-computer-use-verify-'))
  const operationPath = join(dir, 'operation.json')
  try {
    writeFileSync(operationPath, JSON.stringify({ tool: 'handshake' }), { mode: 0o600 })
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'native/computer-use-windows/runtime.ps1',
        operationPath
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    if (result.status !== 0 || result.error) {
      process.stderr.write(result.stderr ?? '')
      return false
    }
    const response = JSON.parse(result.stdout.trim())
    if (response.ok === true && response.capabilities?.protocolVersion === 1) {
      console.log('[computer-native] windows-handshake-ok')
      return true
    }
    console.error(`[computer-native] invalid Windows handshake response: ${result.stdout}`)
    return false
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function verifyNativeArgumentGuardrails() {
  const linux = readFileSync(join(repoRoot, 'native/computer-use-linux/runtime.py'), 'utf8')
  const macos = readFileSync(
    join(repoRoot, 'native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift'),
    'utf8'
  )
  const windows = readFileSync(join(repoRoot, 'native/computer-use-windows/runtime.ps1'), 'utf8')
  const failures = []
  if (linux.includes('count or 1') || linux.includes('pages or 1')) {
    failures.push('Linux provider must not coerce explicit zero action values to defaults')
  }
  if (!linux.includes('1 if count is None else count')) {
    failures.push('Linux click_count default must only apply when the value is missing')
  }
  if (!linux.includes('1 if pages is None else pages')) {
    failures.push('Linux pages default must only apply when the value is missing')
  }
  const linuxScrollDefaultPattern = ['str(direction or ', '"down").lower()'].join('')
  if (linux.includes(linuxScrollDefaultPattern) || !linux.includes('direction is required')) {
    failures.push('Linux scroll direction must be required instead of defaulting to down')
  }
  if (
    !linux.includes('def require_non_empty_string(value, name):') ||
    !linux.includes('type_text(require_non_empty_string(operation.get("text"), "text"))') ||
    !linux.includes('press_key(require_non_empty_string(operation.get("key"), "key"))')
  ) {
    failures.push(
      'Linux text/key actions must reject missing payloads instead of sending empty input'
    )
  }
  if (!linux.includes('"targetById": False')) {
    failures.push('Linux provider must not advertise stable window-id targeting')
  }
  if (
    !linux.includes('def parse_positive_pid(value):') ||
    !linux.includes('requested_pid is not None and pid_of(app) == requested_pid')
  ) {
    failures.push('Linux pid:N selectors must only match positive process ids')
  }
  if (!linux.includes('"windowId": None') || !linux.includes('"windowIndex": window_index')) {
    failures.push('Linux snapshots must expose AT-SPI child targets as windowIndex, not windowId')
  }
  if (
    !linux.includes(
      'def first_descendant(root, predicate, max_nodes=MAX_NODES, max_depth=MAX_DEPTH)'
    )
  ) {
    failures.push('Linux focused-element traversal must share the snapshot node/depth budget')
  }
  if (linux.includes('first_descendant(child, predicate)')) {
    failures.push('Linux focused-element traversal must not recurse outside the snapshot budget')
  }
  if (
    linux.includes('return screenshot_payload(best_data, best_width, best_height, original_width)')
  ) {
    failures.push('Linux screenshot payloads must not return oversized best-effort PNGs')
  }
  if (!linux.includes('write_clipboard("")')) {
    failures.push(
      'Linux paste_text must clear the temporary clipboard text when no prior value was readable'
    )
  }
  if (!linux.includes('"screenshotError": screenshot.get("error") if screenshot else None')) {
    failures.push('Linux size-dropped screenshots must report a structured screenshotError')
  }
  if (!linux.includes('screenshot exceeded the computer-use payload cap after downscaling')) {
    failures.push('Linux screenshot cap failures must explain the size-drop recovery path')
  }
  if (linux.includes('operation.get("restoreWindow") or has_state')) {
    failures.push('Linux keyboard focus checks must verify focus after --restore-window')
  }
  if (!linux.includes('restoreWindow was requested but the target window is still not focused')) {
    failures.push('Linux keyboard focus failures after restore must explain the recovery state')
  }
  if (!linux.includes('"verification code"') || !linux.includes('return "[redacted]"')) {
    failures.push('Linux secure fields must redact verification-code/password-style values')
  }
  if (!linux.includes('re.search(r"(^|[^a-z0-9])pin([^a-z0-9]|$)", label)')) {
    failures.push(
      'Linux PIN redaction must match standalone PIN labels without hiding spin buttons'
    )
  }
  if (linux.includes('"password", "passcode", "pin", "secret"')) {
    failures.push('Linux secure-field redaction must not treat pin as a raw substring')
  }
  if (!linux.includes('def restore_window(app, window=None):')) {
    failures.push('Linux restore must accept the selected window target')
  }
  if (!linux.includes('Atspi.Component.grab_focus(component)')) {
    failures.push('Linux restore must try AT-SPI focus on the selected window before PID fallback')
  }
  if (/restore_window\(app\)(?!:)/.test(linux)) {
    failures.push('Linux restore call sites must pass the selected window target')
  }
  if (!linux.includes('even when the click uses an accessibility path')) {
    failures.push(
      'Linux clicks must activate the target window before accessibility or pointer input'
    )
  }
  if (
    !linux.includes('compact_browser_tabs=is_browser_app(query, app)') ||
    !linux.includes('inactive browser tabs omitted')
  ) {
    failures.push('Linux browser snapshots must compact large inactive browser tab strips')
  }
  if (
    !linux.includes('record.get("isSelected")') ||
    !linux.includes('sanitize_text(record.get("value")) == "1"')
  ) {
    failures.push('Linux browser tab compaction must preserve selected-tab fallbacks')
  }
  if (!linux.includes('pointer wheel events should land in the requested app window')) {
    failures.push(
      'Linux synthetic scroll must activate the target window before posting pointer input'
    )
  }
  if (!linux.includes('pointer drags are synthetic global input')) {
    failures.push(
      'Linux synthetic drag must activate the target window before posting pointer input'
    )
  }
  if (
    !linux.includes('"pageup": "Page_Up"') ||
    !linux.includes('"pagedown": "Page_Down"') ||
    !linux.includes('"insert": "Insert"')
  ) {
    failures.push('Linux key aliases must accept common PageUp/PageDown/Insert names')
  }
  if (
    !macos.includes('private func typeText') ||
    !macos.includes('TextInput.replaceSelection(focused.element, with: text)')
  ) {
    failures.push(
      'macOS typeText must try verified focused AX text replacement before synthetic keyboard fallback'
    )
  }
  if (!macos.includes('even when the click uses an AX action path')) {
    failures.push(
      'macOS clicks must activate the target window before accessibility or pointer input'
    )
  }
  if (
    !macos.includes('if visibleWindowCount > 0') ||
    !macos.includes('ProviderError.coded("permission_denied", "app') ||
    !macos.includes('has visible windows but no accessibility window')
  ) {
    failures.push('macOS visible windows without AX access must be reported as permission_denied')
  }
  if (!macos.includes('"pid:\\(app.pid)"')) {
    failures.push(
      'macOS snapshot cache must alias follow-up actions by the documented pid:N selector'
    )
  }
  const macOSElementSignature = swiftFunctionBody(macos, 'elementSignature')
  if (
    macOSElementSignature?.includes('node.value') ||
    macOSElementSignature?.includes('node.placeholder')
  ) {
    failures.push(
      'macOS element identity must not include mutable text value or placeholder content'
    )
  }
  const macOSCurrentSnapshot = swiftFunctionBody(macos, 'currentSnapshot')
  const macOSPruneIndex = macOSCurrentSnapshot?.indexOf('pruneSnapshotCache()') ?? -1
  const macOSCachedIndex = macOSCurrentSnapshot?.indexOf('cachedSnapshot(params: params)') ?? -1
  if (macOSPruneIndex < 0 || macOSCachedIndex < 0 || macOSPruneIndex > macOSCachedIndex) {
    failures.push('macOS cached snapshots must be pruned before cached element lookup')
  }
  if (
    !macos.includes('"pageup": 116') ||
    !macos.includes('"pagedown": 121') ||
    !macos.includes('"insert": 114')
  ) {
    failures.push('macOS key aliases must accept common PageUp/PageDown/Insert names')
  }
  if (
    !macos.includes('haystack.contains("verification code")') ||
    !macos.includes('return "[redacted]"')
  ) {
    failures.push('macOS secure fields must redact verification-code/password-style values')
  }
  if (windows.includes('if ([bool]$Operation.restoreWindow) { return }')) {
    failures.push('Windows keyboard focus checks must verify focus after --restore-window')
  }
  if (
    !windows.includes('function Test-OrcaSensitiveElement') ||
    !windows.includes('"verification code"') ||
    !windows.includes('if (Test-OrcaSensitiveElement $Element) { return "[redacted]" }')
  ) {
    failures.push(
      'Windows secure fields must redact labeled verification-code/password-style values'
    )
  }
  if (
    !windows.includes('function Get-OrcaRequiredString($Value, [string]$Name)') ||
    !windows.includes('Send-OrcaText $handle (Get-OrcaRequiredString $Operation.text "text")') ||
    !windows.includes('Send-OrcaKey $handle (Get-OrcaRequiredString $Operation.key "key")')
  ) {
    failures.push(
      'Windows text/key actions must reject missing payloads instead of sending empty input'
    )
  }
  if (!windows.includes('even when UI Automation handles the click')) {
    failures.push(
      'Windows clicks must activate the target window before UI Automation or pointer input'
    )
  }
  if (
    !windows.includes('Render-OrcaTree $root $windowFrame (Test-OrcaBrowserProcess $process)') ||
    !windows.includes('inactive browser tabs omitted')
  ) {
    failures.push('Windows browser snapshots must compact large inactive browser tab strips')
  }
  if (
    !windows.includes('[bool]$record.isSelected') ||
    !windows.includes('(Format-OrcaSnapshotText $record.value) -eq "1"')
  ) {
    failures.push('Windows browser tab compaction must preserve selected-tab fallbacks')
  }
  if (!windows.includes('restoreWindow was requested but the target window is still not focused')) {
    failures.push('Windows keyboard focus failures after restore must explain the recovery state')
  }
  const windowFrameFunction = powerShellFunctionBody(windows, 'Get-OrcaWindowFrame')
  if (!windowFrameFunction?.includes('$null')) {
    failures.push('Windows window-frame fallback must return null when bounds are unavailable')
  }
  if (windowFrameFunction?.includes('screenshot_failed')) {
    failures.push('Windows window-frame fallback must not return screenshot failure objects')
  }
  const renderedElementIndexFunction = powerShellFunctionBody(
    windows,
    'Get-OrcaRenderedElementIndex'
  )
  if (!renderedElementIndexFunction?.includes('$null')) {
    failures.push('Windows rendered element index parsing must return null for non-index lines')
  }
  if (renderedElementIndexFunction?.includes('screenshot_failed')) {
    failures.push(
      'Windows rendered element index parsing must not return screenshot failure objects'
    )
  }
  if (windows.includes('New-OrcaScreenshotPayload $bestBytes $bestWidth $bestHeight')) {
    failures.push('Windows screenshot payloads must not return oversized best-effort PNGs')
  }
  const boundedScreenshotFunction = powerShellFunctionBody(
    windows,
    'Get-OrcaBoundedScreenshotPayload'
  )
  if (!boundedScreenshotFunction?.includes('error = [pscustomobject]')) {
    failures.push('Windows screenshot cap failures must return a structured error object')
  }
  if (
    !boundedScreenshotFunction?.includes(
      'screenshot exceeded the computer-use payload cap after downscaling'
    )
  ) {
    failures.push('Windows screenshot cap failures must explain the size-drop recovery path')
  }
  if (
    !windows.includes(
      'screenshotError = if ($null -ne $screenshot) { $screenshot.error } else { $null }'
    )
  ) {
    failures.push('Windows size-dropped screenshots must report a structured screenshotError')
  }
  if (
    windows.includes(
      'Send-OrcaMouseClick $handle $point.x $point.y $Operation.mouse_button ([int]$Operation.click_count)'
    )
  ) {
    failures.push('Windows click_count must be validated before Send-OrcaMouseClick')
  }
  if (
    !windows.includes('$clickCount = Get-OrcaPositiveInteger $Operation.click_count "click_count"')
  ) {
    failures.push('Windows click_count default must be handled by Get-OrcaPositiveInteger')
  }
  if (
    !windows.includes('@("pageup", "page_up")') ||
    !windows.includes('@("pagedown", "page_down")') ||
    !windows.includes('{ return "{INSERT}" }')
  ) {
    failures.push('Windows key aliases must accept common PageUp/PageDown/Insert names')
  }

  for (const failure of failures) {
    console.error(`[computer-native] ${failure}`)
  }
  return failures.length === 0
}

function powerShellFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}`)
  if (start < 0) {
    return null
  }
  const bodyStart = source.indexOf('{', start)
  if (bodyStart < 0) {
    return null
  }
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    const character = source[index]
    if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  return null
}

function swiftFunctionBody(source, name) {
  const start = source.indexOf(`func ${name}`)
  if (start < 0) {
    return null
  }
  const bodyStart = source.indexOf('{', start)
  if (bodyStart < 0) {
    return null
  }
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    const character = source[index]
    if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  return null
}

function run(command, args) {
  if (!hasCommand(command)) {
    console.log(`[computer-native] skip ${command}: command not found`)
    return true
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  return result.status === 0 && !result.error
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
