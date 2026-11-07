// Per-build dirs: entries are content-hashed so stale code is never reused, and pruning stops old builds piling up.
export function createMainCompileCacheBanner(commitLiteral: string): string {
  return `
;(() => {
  try {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
    const { app } = require('electron'), root = path.join(app.getPath('userData'), 'compile-cache')
    const build = app.getVersion() + '-' + ${commitLiteral}
    if (Module.enableCompileCache(path.join(root, build)).status !== Module.constants.compileCacheStatus.ENABLED) return
    fs.readdir(root, (_, names = []) => names.filter((name) => name !== build).forEach((name) => fs.rm(path.join(root, name), { recursive: true, force: true }, () => {})))
    process.once('exit', () => Module.flushCompileCache())
  } catch {}
})();
`
}
