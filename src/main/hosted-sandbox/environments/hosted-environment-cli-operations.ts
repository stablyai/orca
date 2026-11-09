// What `orca cloud env ...` may do, resolved against the control plane. Deliberately narrow: an agent
// configuring the environment reads it, replaces the install script and runs builds. Repos, env var
// names, machine size and secrets stay with people in Settings.
import type {
  CloudEnvironmentBuildsData,
  CloudEnvironmentFollowData,
  CloudEnvironmentRef,
  CloudEnvironmentSetInstallScriptData,
  CloudEnvironmentShowData,
  CloudEnvironmentStartBuildData
} from '../../../shared/hosted-sandbox/hosted-environment-cli-contract'
import {
  isHostedEnvironmentBuildId,
  type HostedEnvironmentListEntry
} from '../../../shared/hosted-sandbox/hosted-environment-wire'
import type { HostedEnvironmentBuildFollowers } from './hosted-environment-build-followers'
import {
  HostedEnvironmentUserError,
  type HostedEnvironmentClient
} from './hosted-environment-client'

const knownEnvironmentNames = new Map<string, string>()

export async function resolveCloudEnvironment(
  client: Pick<HostedEnvironmentClient, 'list'>,
  selector: string | undefined
): Promise<{ entry: HostedEnvironmentListEntry; all: CloudEnvironmentRef[]; canAdmin: boolean }> {
  const { environments, canAdmin } = await client.list()
  const all = environments.map((environment) => ({ id: environment.id, name: environment.name }))
  knownEnvironmentNames.clear()
  for (const environment of all) {
    knownEnvironmentNames.set(environment.id, environment.name)
  }
  if (environments.length === 0) {
    throw new HostedEnvironmentUserError(
      'not_found',
      'no_environments',
      'This org has no environment yet. Create one in Settings > Orca Cloud.'
    )
  }
  if (!selector) {
    return { entry: environments[0], all, canAdmin }
  }
  const lowered = selector.toLowerCase()
  const entry =
    environments.find((environment) => environment.id === selector) ??
    environments.find((environment) => environment.name.toLowerCase() === lowered)
  if (!entry) {
    throw new HostedEnvironmentUserError(
      'not_found',
      'environment_not_found',
      `No environment named "${selector.slice(0, 128)}". Known: ${all.map((env) => env.name).join(', ')}.`
    )
  }
  return { entry, all, canAdmin }
}

const ref = (entry: { id: string; name: string }): CloudEnvironmentRef => ({
  id: entry.id,
  name: entry.name
})

export async function showCloudEnvironment(
  client: HostedEnvironmentClient,
  selector: string | undefined,
  refresh = false
): Promise<CloudEnvironmentShowData> {
  const { entry, all, canAdmin } = await resolveCloudEnvironment(client, selector)
  const { activeBuild, latestBuild, ...environment } = entry
  // Staleness asks GitHub; a failure there should not hide the environment itself.
  const staleness = await client.staleness(entry.id, refresh).catch(() => null)
  return { environment, activeBuild, latestBuild, staleness, canAdmin, environments: all }
}

export async function setCloudEnvironmentInstallScript(
  client: HostedEnvironmentClient,
  selector: string | undefined,
  script: string,
  expectedRevision?: number
): Promise<CloudEnvironmentSetInstallScriptData> {
  const { entry } = await resolveCloudEnvironment(client, selector)
  // Only the script: this surface must never carry repos, env var names or machine size.
  const environment = await client.update(entry.id, {
    installScript: script,
    expectedRevision: expectedRevision ?? entry.revision
  })
  return { environment }
}

export async function startCloudEnvironmentBuild(
  client: HostedEnvironmentClient,
  selector: string | undefined
): Promise<CloudEnvironmentStartBuildData> {
  const { entry } = await resolveCloudEnvironment(client, selector)
  return { environment: ref(entry), build: await client.startBuild(entry.id) }
}

export async function listCloudEnvironmentBuilds(
  client: HostedEnvironmentClient,
  selector: string | undefined
): Promise<CloudEnvironmentBuildsData> {
  const { entry } = await resolveCloudEnvironment(client, selector)
  const detail = await client.get(entry.id)
  return { environment: ref(entry), builds: detail.builds }
}

export async function followCloudEnvironmentBuild(
  client: HostedEnvironmentClient,
  followers: HostedEnvironmentBuildFollowers,
  args: { env?: string; build: string; cursor?: number; waitMs?: number }
): Promise<CloudEnvironmentFollowData> {
  // Polls repeat every few seconds: once the CLI holds both ids, skip the list round trip.
  const envId = args.env
  const known = envId ? knownEnvironmentNames.get(envId) : undefined
  const environment =
    envId && known !== undefined && isHostedEnvironmentBuildId(args.build)
      ? { id: envId, name: known }
      : ref((await resolveCloudEnvironment(client, args.env)).entry)
  const buildId = await resolveBuildId(client, environment.id, args.build)
  const poll = await followers.poll(
    client,
    environment.id,
    buildId,
    args.cursor ?? 0,
    args.waitMs ?? 0
  )
  return { environment, ...poll }
}

async function resolveBuildId(
  client: Pick<HostedEnvironmentClient, 'get'>,
  envId: string,
  selector: string
): Promise<string> {
  if (isHostedEnvironmentBuildId(selector)) {
    return selector
  }
  const number = /^#?(\d{1,9})$/.exec(selector)?.[1]
  if (!number) {
    throw new HostedEnvironmentUserError(
      'invalid_request',
      'build',
      'Pass a build number (e.g. 12) or a build id (bld_...).'
    )
  }
  const { builds } = await client.get(envId)
  const build = builds.find((candidate) => candidate.number === Number(number))
  if (!build) {
    throw new HostedEnvironmentUserError(
      'not_found',
      'build_not_found',
      `Build #${number} is not among the 30 most recent builds; pass its id instead.`
    )
  }
  return build.id
}
