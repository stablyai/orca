import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { getVercelOidcToken } from '@vercel/oidc'

export const ORCA_REF = '6252f8149bc5b72985e830ff830a178f61997b8b'
export const ROOT = '/vercel/orca-runtime'
export const PROJECT = '/vercel/project'
export const PROFILE = '/vercel/orca-profile'
export const CONTROL = '/vercel/orca-control'
export const PORT = 6768

export function validateConfig(config) {
  for (const key of ['team', 'project', 'stateDirectory']) {
    if (typeof config[key] !== 'string' || !config[key]) {
      throw new Error(`Missing config: ${key}`)
    }
  }
  if (!isAbsolute(config.stateDirectory)) {
    throw new Error('stateDirectory must be absolute')
  }
  if (config.snapshotId && !/^snap_[A-Za-z0-9]+$/.test(config.snapshotId)) {
    throw new Error('Invalid snapshotId')
  }
  if (config.repoUrl) {
    const url = new URL(config.repoUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('repoUrl must be an HTTPS URL without credentials, query or fragment')
    }
  }
  if (config.repoRef && !/^[a-f0-9]{40}$/.test(config.repoRef)) {
    throw new Error('repoRef must be a full commit SHA')
  }
  const timeout = config.timeoutMs ?? 30 * 60 * 1000
  if (!Number.isInteger(timeout) || timeout < 60000 || timeout > 30 * 60 * 1000) {
    throw new Error('timeoutMs must be 60000..1800000')
  }
  return { ...config, timeoutMs: timeout, region: config.region ?? 'iad1' }
}

export function loadConfig() {
  const path = process.env.ORCA_VERCEL_CONFIG
  if (!path || !isAbsolute(path)) {
    throw new Error('Set ORCA_VERCEL_CONFIG to an absolute private JSON config path')
  }
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')))
}

export async function credentials(config) {
  if (process.env.VERCEL_TOKEN) {
    if (!config.team.startsWith('team_') || !config.project.startsWith('prj_')) {
      throw new Error('VERCEL_TOKEN requires team/project IDs in config')
    }
    return { token: process.env.VERCEL_TOKEN, teamId: config.team, projectId: config.project }
  }
  const token = await getVercelOidcToken({ team: config.team, project: config.project })
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  if (!claims.owner_id || !claims.project_id) {
    throw new Error('OIDC token lacks project scope')
  }
  return { token, teamId: claims.owner_id, projectId: claims.project_id }
}

export function agentEnvironment() {
  return process.env.AI_GATEWAY_API_KEY
    ? { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY }
    : {}
}
