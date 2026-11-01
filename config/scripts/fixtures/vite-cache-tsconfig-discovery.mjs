import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveConfig as resolveElectronConfig } from 'electron-vite'
import { createServer, loadConfigFromFile } from 'vite'

const [repoRoot, client, boundary] = process.argv.slice(2)
const cacheRoot = resolve('.cache/vite')
let config
if (client === 'renderer') {
  const resolved = await resolveElectronConfig(
    { configFile: resolve(repoRoot, 'electron.vite.config.ts'), logLevel: 'silent' },
    'serve'
  )
  config = resolved.config?.renderer
} else {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    resolve(repoRoot, 'vite.web.config.ts')
  )
  config = loaded?.config
}
assert.ok(config)
const server = await createServer({
  ...config,
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true, watch: null, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ['react/jsx-dev-runtime'] },
  plugins: [
    ...config.plugins,
    ...(boundary !== 'present'
      ? [
          {
            name: 'remove-cache-tsconfig-for-regression',
            async configureServer() {
              const file = resolve(cacheRoot, 'tsconfig.json')
              await (boundary === 'absent' ? rm(file, { force: true }) : writeFile(file, '{}'))
            }
          }
        ]
      : [])
  ]
})
try {
  assert.equal(server.config.tsconfig, undefined)
  assert.equal(server.config.cacheDir, resolve(cacheRoot, client).replaceAll('\\', '/'))
  const entry = await server.transformRequest('/src/entry.tsx')
  assert.ok(entry)
  const dependencyUrl = entry.code.match(/"([^"]*react_jsx-dev-runtime\.js[^"]*)"/)?.[1]
  assert.ok(dependencyUrl, entry.code)
  if (boundary !== 'present') {
    await assert.rejects(
      server.transformRequest(dependencyUrl),
      /Failed to load tsconfig '@missing-parent-checkout\/tsconfig'/
    )
    console.log(JSON.stringify({ client, parentConfigRejected: true }))
  } else {
    const dependency = await server.transformRequest(dependencyUrl)
    assert.ok(dependency?.code.includes('jsxDEV'))
    const source = await server.transformRequest('/src/fields.ts')
    const nested = await server.transformRequest('/src/nested/fields.ts')
    assert.ok(source?.code.includes('this.value = 1'), source?.code)
    assert.ok(
      nested?.code.includes('value = 1') && !nested.code.includes('this.value'),
      nested?.code
    )
    console.log(
      JSON.stringify({ client, cachedDependency: true, sourceConfig: true, nestedConfig: true })
    )
  }
} finally {
  await server.close()
}
