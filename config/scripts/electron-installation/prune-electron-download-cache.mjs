#!/usr/bin/env node
// Keeps only this checkout's Electron downloads: release caches restore older entries by prefix,
// so every Electron bump otherwise re-saved all previous ~140 MB zips (eight in electron-builder-win).
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function defaultElectronCacheDir(env = process.env, platform = process.platform) {
  if (env.ELECTRON_CACHE) {
    return env.ELECTRON_CACHE
  }
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'electron')
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron')
}

/** Removes per-URL cache directories whose artifacts name another Electron version. */
export function pruneElectronDownloadCache(cacheDir, version) {
  const removed = []
  if (!existsSync(cacheDir)) {
    return removed
  }
  for (const entry of readdirSync(cacheDir)) {
    const dir = join(cacheDir, entry)
    if (!statSync(dir).isDirectory()) {
      continue
    }
    const versions = readdirSync(dir).flatMap((file) => {
      const match = /^[a-z-]+-v(\d+\.\d+\.\d+[^-]*)-.+\.zip$/.exec(file)
      return match ? [match[1]] : []
    })
    if (versions.length > 0 && versions.every((found) => found !== version)) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(entry)
    }
  }
  return removed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, '../../..')
  const version = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  ).devDependencies.electron.replace(/^[^\d]*/, '')
  const cacheDir = defaultElectronCacheDir()
  const removed = pruneElectronDownloadCache(cacheDir, version)
  console.log(
    `[electron-cache] kept Electron ${version} in ${cacheDir}; removed ${removed.length} stale download(s)`
  )
}
