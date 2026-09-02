import { quoteShell } from './cli-install-path-format'

const APPIMAGE_CLI_SCRIPT = [
  '(async()=>{',
  'try{',
  'const path=require("path");',
  'const appDir=process.env.APPDIR;',
  'if(!appDir){console.error("Orca AppImage runtime did not set APPDIR.");process.exit(1);}',
  'const cli=path.join(appDir,"resources","app.asar.unpacked","out","cli","index.js");',
  'await Promise.resolve(require(cli).main(process.argv.slice(1)));',
  '}catch(error){',
  'console.error(error&&error.stack?error.stack:String(error));process.exit(1);',
  '}',
  '})();'
].join('')

export function extractLegacyAppImageCliWrapperTarget(content: string): string | null {
  const assignment = /^APPIMAGE=([\s\S]+?)\nif \[ ! -f "\$APPIMAGE" \]; then/mu.exec(content)?.[1]
  const appImagePath = assignment ? unquoteShell(assignment) : null
  return appImagePath && content === buildLegacyAppImageCliWrapper(appImagePath)
    ? appImagePath
    : null
}

export function buildLegacyAppImageCliWrapper(appImagePath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
APPIMAGE=${quoteShell(appImagePath)}
if [ ! -f "$APPIMAGE" ]; then
  echo "Orca AppImage not found at $APPIMAGE" >&2
  echo "If you moved the AppImage, re-run CLI registration from Orca Settings." >&2
  exit 1
fi
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
# Why: AppImage mount paths change on each launch; $APPDIR is the runtime mount.
ELECTRON_RUN_AS_NODE=1 exec "$APPIMAGE" -e ${quoteShell(APPIMAGE_CLI_SCRIPT)} -- "$@"
`
}

function unquoteShell(value: string): string | null {
  if (!value.startsWith("'") || !value.endsWith("'")) {
    return null
  }
  const decoded = value.slice(1, -1).split(`'"'"'`).join("'")
  return quoteShell(decoded) === value ? decoded : null
}
