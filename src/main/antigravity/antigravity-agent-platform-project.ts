// Agent Platform needs a Google Cloud project and location; fill them from the host's gcloud setup.

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

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

const AdcFileSchema = z.object({
  quota_project_id: z.string().trim().min(1).optional(),
  project_id: z.string().trim().min(1).optional()
})

/** ADC's quota project, else a service account key's own project. */
async function readAdcProject(path: string): Promise<string | null> {
  try {
    const parsed = AdcFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? (parsed.data.quota_project_id ?? parsed.data.project_id ?? null) : null
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
    (await readAdcProject(adcFile)) ||
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
  // Google's Go client finds ADC under HOME, not CLOUDSDK_CONFIG, so name the file Orca read.
  const adcFile = env.GOOGLE_APPLICATION_CREDENTIALS
    ? null
    : env.CLOUDSDK_CONFIG
      ? join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json')
      : null
  const adcExists = adcFile ? (await stat(adcFile).catch(() => null))?.isFile() === true : false
  return {
    ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}),
    GOOGLE_CLOUD_LOCATION: location,
    ...(adcFile && adcExists ? { GOOGLE_APPLICATION_CREDENTIALS: adcFile } : {})
  }
}
