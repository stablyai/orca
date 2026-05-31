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

export function buildAppImageCliWrapper(appImagePath: string): string {
  // Why: AppImage mounts resources under a fresh FUSE path per launch, so the
  // installed command must call the stable outer AppImage and resolve APPDIR.
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

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
