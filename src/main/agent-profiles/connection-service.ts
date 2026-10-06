import { supportsAgentProfileHost } from '../../shared/agent-profile-capabilities'
import {
  isAgentProfileConnectionInput,
  isAgentProfileSaveInput,
  type AgentProfileSaveInput
} from '../../shared/agent-profile-connection'
import { validateResolvedProfileSnapshot } from './snapshot-resolution'
import {
  validatePreparedProfileLaunch,
  profileIdentityMetadata,
  inspectExternalProfileIdentity,
  type ProfileLaunchContext
} from './launch-authority'
import { sanitizedProfilePreparationError } from './preparation-error'
// Resolves profile bindings on their execution host without acquiring external credentials.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { claudeConfigDirEnvPatch } from '../claude/claude-config-dir-pin'
import {
  captureAgentLaunchProfile,
  isAgentLaunchProfile,
  validateAgentLaunchProfileName,
  type AgentLaunchProfile,
  type AgentProfileSnapshot,
  type ProfileAgent,
  type ProfileBinding,
  type ProfileIdentity
} from '../../shared/agent-launch-profile'
import { parseProfileCommand } from '../agent-profile-discovery/command'
import { discoverLiteralProfileAlias } from '../agent-profile-discovery/literal-alias'
import { validateExternalProfileHome } from '../agent-profile-discovery/existing-home'
import {
  createProfileExecutableDetector,
  readConventionalProfileAliases,
  resolveProfileExecutable
} from './host-discovery'
import type { ProfilePreparationOptions } from './provider-adapters'

import type {
  AgentProfileConnectionInput,
  AgentProfileCandidate,
  PreparedAgentProfile,
  ProfileConnectionDependencies
} from './connection-contracts'
export type {
  AgentProfileConnectionInput,
  AgentProfileCandidate,
  PreparedAgentProfile,
  ProfileConnectionDependencies
} from './connection-contracts'

export class AgentProfileConnectionService {
  private mutations: Promise<unknown> = Promise.resolve()
  constructor(private readonly dependencies: ProfileConnectionDependencies) {}

  private guard(): void {
    const host = this.dependencies.host
    if (!supportsAgentProfileHost(host)) {
      throw new Error('Profiles are supported on local macOS/Linux hosts only.')
    }
  }
  private async executable(agent: ProfileAgent): Promise<{ detected: string; canonical: string }> {
    const detected = await (
      this.dependencies.detectExecutable ?? createProfileExecutableDetector(this.dependencies.host)
    )(agent)
    return resolveProfileExecutable(detected)
  }
  private async home(path: string): Promise<string> {
    const validated = await validateExternalProfileHome(path)
    if (!validated.ok) {
      throw new Error('Configuration home is unavailable or invalid. Choose an existing folder.')
    }
    return validated.home
  }
  async preview(input: AgentProfileConnectionInput): Promise<AgentProfileCandidate> {
    this.guard()
    if (!isAgentProfileConnectionInput(input)) {
      throw new Error('Invalid profile connection.')
    }
    const adapter = this.dependencies.adapters[input.agent]
    if (!adapter || adapter.agent !== input.agent) {
      throw new Error('Unsupported profile agent.')
    }
    const { detected, canonical: executable } = await this.executable(input.agent)
    let binding: ProfileBinding
    let resolvedHome: string
    let identity: ProfileIdentity
    if (input.source.kind === 'managed') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.source.accountId)) {
        throw new Error('Invalid managed account reference.')
      }
      const observed = await adapter
        .inspectManaged(input.source.accountId)
        .catch((error: unknown) => {
          throw sanitizedProfilePreparationError(error, 'Managed account inspection failed.')
        })
      resolvedHome = await this.home(observed.home)
      identity = profileIdentityMetadata(observed.identity)
      binding = { kind: 'managed', accountId: input.source.accountId }
    } else {
      const host = this.dependencies.host
      let path = input.source.value
      if (input.source.kind === 'command') {
        const context = {
          commandName: input.agent,
          executable: detected,
          homeVariable: adapter.homeVariable,
          hostHome: host.home,
          platform: host.platform
        }
        const isAliasName = /^[A-Za-z0-9_.-]{1,128}$/.test(path)
        const sources = isAliasName
          ? await (this.dependencies.readAliases ?? (() => readConventionalProfileAliases(host)))()
          : []
        const discover = (trustedExecutable: string) => {
          const trustedContext = { ...context, executable: trustedExecutable }
          return isAliasName
            ? discoverLiteralProfileAlias(path, sources, trustedContext)
            : parseProfileCommand(path, trustedContext)
        }
        let parsed = discover(detected)
        if (parsed.kind !== 'resolved' && detected !== executable) {
          parsed = discover(executable)
        }
        if (parsed.kind !== 'resolved') {
          throw new Error('Command cannot be safely resolved. Choose a configuration folder.')
        }
        path = parsed.home
      } else if (path.startsWith('~/')) {
        path = host.home + path.slice(1)
      }
      resolvedHome = await this.home(path)
      binding = { kind: 'external', home: resolvedHome }
      identity = await inspectExternalProfileIdentity(
        this.dependencies,
        input.agent,
        executable,
        resolvedHome
      )
    }
    return {
      agent: input.agent,
      hostId: this.dependencies.host.hostId,
      executable,
      binding,
      resolvedHome,
      identity
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation)
    this.mutations = result.catch(() => undefined)
    return result
  }
  save(input: AgentProfileSaveInput): Promise<AgentLaunchProfile> {
    return this.serialize(async () => {
      this.guard()
      if (!isAgentProfileSaveInput(input)) {
        throw new Error('Invalid profile data.')
      }
      const profiles = await this.dependencies.store.read()
      if (input.id !== undefined && !profiles.some((profile) => profile.id === input.id)) {
        throw new Error('That profile no longer exists.')
      }
      const nameError = validateAgentLaunchProfileName(input.name, profiles, input.id)
      if (nameError) {
        throw new Error(nameError)
      }
      if (input.id === undefined && profiles.length >= 32) {
        throw new Error('A maximum of 32 profiles is supported.')
      }
      const candidate = await this.preview(input.connection)
      if (
        profiles.some(
          (profile) =>
            profile.id !== input.id &&
            profile.agent === candidate.agent &&
            profile.hostId === candidate.hostId &&
            JSON.stringify(profile.binding) === JSON.stringify(candidate.binding)
        )
      ) {
        throw new Error(
          'This agent home is already connected. Rename or edit its existing profile.'
        )
      }
      const profile: AgentLaunchProfile = {
        id: input.id ?? randomUUID(),
        name: input.name.trim(),
        agent: candidate.agent,
        hostId: candidate.hostId,
        executable: candidate.executable,
        binding: { ...candidate.binding }
      }
      if (!isAgentLaunchProfile(profile)) {
        throw new Error('Invalid profile data.')
      }
      await this.dependencies.store.write(
        input.id === undefined
          ? [...profiles, profile]
          : profiles.map((entry) => (entry.id === input.id ? profile : entry))
      )
      return profile
    })
  }
  unlink(id: string): Promise<void> {
    return this.serialize(async () => {
      this.guard()
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        throw new Error('Invalid profile reference.')
      }
      await this.dependencies.store.write(
        (await this.dependencies.store.read()).filter((profile) => profile.id !== id)
      )
    })
  }
  validateLaunch(prepared: PreparedAgentProfile, context: ProfileLaunchContext): Promise<void> {
    return validatePreparedProfileLaunch(this.dependencies.adapters, prepared, context)
  }
  async prepareById(id: string, options: ProfilePreparationOptions): Promise<PreparedAgentProfile> {
    await this.mutations
    return this.prepare(
      captureAgentLaunchProfile(await this.dependencies.store.read(), id),
      options
    )
  }
  async resolveSnapshot(
    profile: AgentLaunchProfile | AgentProfileSnapshot,
    options: ProfilePreparationOptions
  ): Promise<AgentProfileSnapshot> {
    this.guard()
    if (!isAgentLaunchProfile(profile) || profile.hostId !== this.dependencies.host.hostId) {
      throw new Error('Profile host or binding is invalid.')
    }
    const candidate = await this.preview({
      agent: profile.agent,
      source:
        profile.binding.kind === 'managed'
          ? { kind: 'managed', accountId: profile.binding.accountId }
          : { kind: 'home', value: profile.binding.home }
    })
    return validateResolvedProfileSnapshot(profile, candidate, options)
  }
  async resolveSnapshotById(
    id: string,
    options: ProfilePreparationOptions
  ): Promise<AgentProfileSnapshot> {
    await this.mutations
    return this.resolveSnapshot(
      captureAgentLaunchProfile(await this.dependencies.store.read(), id),
      options
    )
  }
  async prepare(
    profile: AgentLaunchProfile | AgentProfileSnapshot,
    options: ProfilePreparationOptions
  ): Promise<PreparedAgentProfile> {
    const snapshot = await this.resolveSnapshot(profile, options)
    const adapter = this.dependencies.adapters[profile.agent]
    if (profile.binding.kind === 'external') {
      let envPatch: Record<string, string> = { [adapter.homeVariable]: snapshot.resolvedHome }
      if (profile.agent === 'claude') {
        const host = this.dependencies.host
        const defaultHome = await validateExternalProfileHome(join(host.home, '.claude'))
        if (defaultHome.ok && defaultHome.home === snapshot.resolvedHome) {
          // Compare canonical default identity without inheriting a shell config-home override.
          envPatch = claudeConfigDirEnvPatch(snapshot.resolvedHome, {
            env: { CLAUDE_CONFIG_DIR: defaultHome.home },
            platform: host.platform
          })
        }
      }
      const usesDefaultHome = !(adapter.homeVariable in envPatch)
      return {
        snapshot,
        priorExecutable: profile.executable,
        envPatch: usesDefaultHome ? { HOME: this.dependencies.host.home } : envPatch,
        envToDelete: usesDefaultHome ? [adapter.homeVariable] : [],
        release: () => {}
      }
    }
    const prepared = await adapter
      .prepareManaged(profile.binding.accountId, options)
      .catch((error: unknown) => {
        throw sanitizedProfilePreparationError(error, 'Managed account preparation failed.')
      })
    try {
      if ((await this.home(prepared.home)) !== snapshot.resolvedHome) {
        throw new Error('Managed profile home changed during preparation.')
      }
      return {
        snapshot,
        priorExecutable: profile.executable,
        envPatch: { ...prepared.envPatch, [adapter.homeVariable]: snapshot.resolvedHome },
        envToDelete: [...new Set([...adapter.authVariables, ...prepared.envToDelete])].filter(
          (key) => key !== adapter.homeVariable
        ),
        release: prepared.release
      }
    } catch (error) {
      prepared.release()
      throw error
    }
  }
}
