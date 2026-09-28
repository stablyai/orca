import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { mobileWebAppModuleClosure } from './build-mobile-web-app-bundle.mjs'
import { readRouteSnapshot } from './mobile-web-app-route-snapshot.mjs'
import { PAGE_ROUTE_MODULES } from './mobile-web-app-page-route-modules.mjs'
import { spawnProcess } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
export const mobileWebCheckArgs = [
  'run',
  '--config',
  'config/vitest.config.ts',
  'config/scripts/mobile-web-app-',
  'config/scripts/build-mobile-web-app-bundle.test.mjs'
]

export async function prepareRouteSnapshot(file, collect = mobileWebAppModuleClosure) {
  rmSync(file, { force: true })
  const routes = []
  for (const route of new Set(PAGE_ROUTE_MODULES.values())) {
    const closure = await collect(['app/_layout', 'app/h/_layout', route])
    routes.push({ route, closure })
  }
  writeFileSync(file, JSON.stringify({ version: 1, routes }))
}

export async function withPreparedRouteSnapshot(file, run) {
  try {
    for (const route of new Set(PAGE_ROUTE_MODULES.values())) {
      if (!readRouteSnapshot(route, file)) {
        throw new Error(`Prepared mobile route snapshot is missing ${route}`)
      }
    }
    return await run(file)
  } finally {
    rmSync(file, { force: true })
  }
}

export async function withRouteSnapshot(run, collect = mobileWebAppModuleClosure) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-route-snapshot-'))
  try {
    const file = join(directory, 'routes.json')
    await prepareRouteSnapshot(file, collect)
    return await withPreparedRouteSnapshot(file, run)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function runTests(file) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess({
      program: process.execPath,
      args: [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        ...mobileWebCheckArgs,
        ...process.argv.slice(2)
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_MOBILE_WEB_ROUTE_SNAPSHOT: file },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
      } else {
        reject(new Error(`Mobile web checks failed (code=${code}, signal=${signal})`))
      }
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--prepare-route-snapshot') {
    if (process.argv.length !== 4) {
      throw new Error('Expected --prepare-route-snapshot FILE')
    }
    await prepareRouteSnapshot(process.argv[3])
  } else if (process.env.ORCA_MOBILE_WEB_PREPARED_ROUTE_SNAPSHOT) {
    await withPreparedRouteSnapshot(process.env.ORCA_MOBILE_WEB_PREPARED_ROUTE_SNAPSHOT, runTests)
  } else {
    await withRouteSnapshot(runTests)
  }
}
