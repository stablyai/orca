// Root mirrors configure-process.ts userData selection; pruning drops only superseded versions inside that root.
export function createMainCompileCacheBanner(commitLiteral: string): string {
  return `
;(() => {
  try {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
    const { app } = require('electron')
    if (process.env.ORCA_E2E_USER_DATA_DIR) return
    const userData = app.isPackaged ? app.getPath('userData') : process.env.ORCA_DEV_USER_DATA_PATH || path.join(app.getPath('appData'), 'orca-dev')
    const root = path.join(userData, 'compile-cache'), version = app.getVersion(), build = version + '-' + ${commitLiteral}
    if (Module.enableCompileCache(path.join(root, build)).status !== Module.constants.compileCacheStatus.ENABLED) return
    fs.readdir(root, (_, names = []) => names.forEach((name) => {
      const match = /^(.+)-[0-9a-f]{40}$/.exec(name)
      if (match && match[1] !== version) fs.rm(path.join(root, name), { recursive: true, force: true }, () => {})
    }))
    process.once('exit', () => Module.flushCompileCache())
  } catch {}
})();
`
}
