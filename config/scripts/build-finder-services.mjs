import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const servicesRoot = path.join(repoRoot, 'resources', 'darwin', 'Finder Services')

export const finderServices = [
  {
    id: 'terminal',
    bundleName: 'New Orca Terminal Here.workflow',
    menuLabel: 'New Orca Terminal Here',
    inputTypes: ['public.folder'],
    cliArgs: ['finder', 'terminal']
  },
  {
    id: 'workspace',
    bundleName: 'New Orca Workspace Here.workflow',
    menuLabel: 'New Orca Workspace Here',
    inputTypes: ['public.folder'],
    cliArgs: ['finder', 'workspace']
  }
]

export function renderFinderServiceScript(service, { orcaCliPath, selectedFolderPath } = {}) {
  assertFinderService(service)
  const cliPath = orcaCliPath ? shellQuote(orcaCliPath) : '"$orca_cli_path"'

  if (selectedFolderPath) {
    return `${scriptHeader()}\n${cliPath} ${service.cliArgs.join(' ')} --path ${shellQuote(selectedFolderPath)}\n`
  }

  return `${scriptHeader()}
if [ "$#" -eq 0 ]; then
  exit 0
fi

resolve_orca_cli_path() {
  if [ -n "${'${ORCA_FINDER_SERVICE_CLI_PATH:-}'}" ]; then
    printf '%s\\n' "$ORCA_FINDER_SERVICE_CLI_PATH"
    return 0
  fi

  service_script_path=${'${ORCA_FINDER_SERVICE_SCRIPT_PATH:-$0}'}
  service_script_dir=$(CDPATH= cd -- "$(dirname -- "$service_script_path")" && pwd -P)
  resources_dir=$(CDPATH= cd -- "$service_script_dir/../../../.." && pwd -P)
  candidate="$resources_dir/bin/orca"
  if [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    return 0
  fi

  if command -v osascript >/dev/null 2>&1; then
    app_path=$(osascript -e 'POSIX path of (path to app id "com.stablyai.orca")' 2>/dev/null || true)
    if [ -n "$app_path" ]; then
      printf '%s\\n' "$app_path/Contents/Resources/bin/orca"
      return 0
    fi
  fi
  printf '%s\\n' 'Unable to resolve packaged Orca CLI path for Finder Service.' >&2
  return 1
}

orca_cli_path=$(resolve_orca_cli_path)
for selected_folder_path do
  ${cliPath} ${service.cliArgs.join(' ')} --path "$selected_folder_path"
done
`
}

if (isMainModule()) {
  buildFinderServices()
}

function buildFinderServices() {
  rmSync(servicesRoot, { recursive: true, force: true })
  mkdirSync(servicesRoot, { recursive: true })

  for (const service of finderServices) {
    const serviceRoot = path.join(servicesRoot, service.bundleName)
    const contentsDir = path.join(serviceRoot, 'Contents')
    const scriptsDir = path.join(contentsDir, 'Resources')
    mkdirSync(scriptsDir, { recursive: true })

    const scriptPath = path.join(scriptsDir, 'run-service.sh')
    writeFileSync(scriptPath, renderFinderServiceScript(service), 'utf8')
    chmodSync(scriptPath, 0o755)
    writeFileSync(path.join(contentsDir, 'Info.plist'), renderInfoPlist(service), 'utf8')
    writeFileSync(path.join(contentsDir, 'document.wflow'), renderWorkflowDocument(service), 'utf8')
  }
}

function scriptHeader() {
  return `#!/bin/sh
set -eu`
}

function assertFinderService(service) {
  if (
    !service ||
    !finderServices.some(
      (candidate) =>
        candidate.id === service.id &&
        candidate.menuLabel === service.menuLabel &&
        sameArray(candidate.inputTypes, service.inputTypes) &&
        sameArray(candidate.cliArgs, service.cliArgs)
    )
  ) {
    throw new TypeError('Expected a Finder Service descriptor')
  }
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function renderInfoPlist(service) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleIdentifier</key>
  <string>com.stablyai.orca.finder-service.${escapePlist(service.id)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapePlist(service.menuLabel)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${escapePlist(service.menuLabel)}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSSendFileTypes</key>
      <array>
${service.inputTypes.map((inputType) => `        <string>${escapePlist(inputType)}</string>`).join('\n')}
      </array>
    </dict>
  </array>
</dict>
</plist>
`
}

function renderWorkflowDocument(service) {
  const script = renderFinderServiceScript(service)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <false/>
          <key>Types</key>
          <array>
${service.inputTypes.map((inputType) => `            <string>${escapePlist(inputType)}</string>`).join('\n')}
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict/>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>${escapePlist(script)}</string>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/sh</string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
      </dict>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`
}

function escapePlist(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}
