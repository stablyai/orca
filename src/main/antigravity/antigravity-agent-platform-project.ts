// Agent Platform needs a Google Cloud project and location; fill them from the host's gcloud setup.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_LOCATION = 'global'

function gcloudConfigDirectory(env: Readonly<Record<string, string>>): string {
  if (env.CLOUDSDK_CONFIG) {
    return env.CLOUDSDK_CONFIG
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'gcloud')
  }
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.config', 'gcloud')
}

async function readJsonField(path: string, field: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const found =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : null
    return typeof found === 'string' && found.trim() ? found.trim() : null
  } catch {
    return null
  }
}

/** `project = …` under [core] of gcloud's active configuration. */
async function readGcloudProject(
  configDirectory: string,
  env: Readonly<Record<string, string>>
): Promise<string | null> {
  const active =
    env.CLOUDSDK_ACTIVE_CONFIG_NAME ||
    (await readFile(join(configDirectory, 'active_config'), 'utf8').catch(() => '')).trim() ||
    'default'
  const ini = await readFile(
    join(configDirectory, 'configurations', `config_${active}`),
    'utf8'
  ).catch(() => '')
  let core = false
  for (const line of ini.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line)
    if (section) {
      core = section[1].trim() === 'core'
      continue
    }
    const entry = core ? /^\s*project\s*=\s*(\S+)\s*$/.exec(line) : null
    if (entry) {
      return entry[1]
    }
  }
  return null
}

/** Saved values win, then the launch environment, then ADC's project, then gcloud's project. */
export async function resolveAgentPlatformProject(
  saved: { gcpProject?: string; gcpLocation?: string },
  env: Readonly<Record<string, string>>
): Promise<{ project: string | null; location: string }> {
  const configDirectory = gcloudConfigDirectory(env)
  const adcFile =
    env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(configDirectory, 'application_default_credentials.json')
  const project =
    saved.gcpProject ||
    env.GOOGLE_CLOUD_PROJECT ||
    (await readJsonField(adcFile, 'quota_project_id')) ||
    // A service account key names its own project.
    (await readJsonField(adcFile, 'project_id')) ||
    env.CLOUDSDK_CORE_PROJECT ||
    (await readGcloudProject(configDirectory, env))
  return {
    project: project || null,
    location: saved.gcpLocation || env.GOOGLE_CLOUD_LOCATION || DEFAULT_LOCATION
  }
}

/** The server prefers these variables over its settings file, so they carry the resolved values. */
export async function agentPlatformEnvironment(
  saved: { gcpProject?: string; gcpLocation?: string },
  env: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  const { project, location } = await resolveAgentPlatformProject(saved, env)
  return { ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}), GOOGLE_CLOUD_LOCATION: location }
}
