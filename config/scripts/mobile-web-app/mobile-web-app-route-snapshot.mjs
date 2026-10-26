import { readFileSync } from 'node:fs'

export function readRouteSnapshot(route, file = process.env.ORCA_MOBILE_WEB_ROUTE_SNAPSHOT) {
  if (!file) {
    return undefined
  }
  // The test runner creates this file for one immutable checkout and deletes it on exit.
  const snapshot = JSON.parse(readFileSync(file, 'utf8'))
  if (snapshot.version !== 1 || !Array.isArray(snapshot.routes)) {
    throw new Error('Invalid mobile route snapshot')
  }
  const entry = snapshot.routes.find((item) => item.route === route)
  if (!entry) {
    return undefined
  }
  if (
    !Array.isArray(entry.closure?.modules) ||
    !Array.isArray(entry.closure?.local) ||
    !entry.closure.modules.every((item) => typeof item === 'string') ||
    !entry.closure.local.every((item) => typeof item === 'string')
  ) {
    throw new Error(`Invalid mobile route closure: ${route}`)
  }
  return entry.closure
}
