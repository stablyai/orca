import { z } from 'zod'
import {
  SshConnectionRouteSchema,
  SshJumpRouteSchema,
  type ConnectionRoute
} from '../transport/connection-route'
import { SshRouteCredentialsSchema, type SshRouteCredentials } from '../transport/ssh-route-auth'
import type { SshConnectionForm } from './ssh-connection-form'

// A saved SSH connection that pairing can reuse as the middle layer between
// this phone and a paired Orca server: one SSH connection plus the socket
// destination (host:port) dialed from that server.
export const SshProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@?#]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256),
  targetHost: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@?#]+$/),
  targetPort: z.number().int().min(1).max(65535).optional(),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  // Another saved SSH connection used as the hop in front of this one.
  jumpProfileId: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,80}$/)
    .optional()
})

export type SshProfile = z.infer<typeof SshProfileSchema>

export function parseSshProfileForm(
  form: SshConnectionForm,
  id: string
): {
  profile: SshProfile
  credentials: SshRouteCredentials
} {
  if (!form.name.trim()) {
    throw new Error('Enter a name for this SSH connection.')
  }
  if (!/^\d+$/.test(form.port)) {
    throw new Error('Enter a valid SSH port.')
  }
  if (form.targetPort.trim() && !/^\d+$/.test(form.targetPort)) {
    throw new Error('Enter a valid target port.')
  }
  const profile = SshProfileSchema.safeParse({
    id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    targetHost: form.targetHost.trim() || 'localhost',
    ...(form.targetPort.trim() ? { targetPort: Number(form.targetPort) } : {}),
    hostKeyFingerprint: form.hostKeyFingerprint.trim(),
    ...(form.jumpProfileId.trim() ? { jumpProfileId: form.jumpProfileId.trim() } : {})
  })
  if (!profile.success) {
    throw new Error(
      'Enter the SSH host, username, ports (1–65535), and a verified SHA256 host-key fingerprint.'
    )
  }
  const credentials = SshRouteCredentialsSchema.safeParse(
    form.auth === 'password'
      ? { kind: 'password', password: form.password }
      : { kind: 'key', privateKey: form.privateKey, passphrase: form.passphrase }
  )
  if (!credentials.success) {
    throw new Error('Enter an SSH password or private key and its optional passphrase.')
  }
  return { profile: profile.data, credentials: credentials.data }
}

// Why: an endpoint on the scheme's default port has an empty URL.port, and a 0
// target port fails the route schema instead of reporting the real problem.
export function wsEndpointPort(endpoint: string): number {
  const parsed = new URL(endpoint)
  if (parsed.port) {
    return Number(parsed.port)
  }
  return parsed.protocol === 'wss:' ? 443 : 80
}

// The credential id doubles as the profile id so one stored secret serves the profile.
// The target port defaults to the paired endpoint's port when the profile leaves it unset.
// A referenced jump profile contributes its connection fields and its own credential id.
export function routeFromSshProfile(
  profile: SshProfile,
  endpointPort: number,
  jumpProfile?: SshProfile
): ConnectionRoute {
  if (profile.jumpProfileId && !jumpProfile) {
    throw new Error(
      `The jump host saved for ${profile.name} is gone. Edit the SSH connection and pick one again.`
    )
  }
  const jump = profile.jumpProfileId
    ? SshJumpRouteSchema.parse({
        host: jumpProfile?.host ?? '',
        port: jumpProfile?.port ?? 0,
        username: jumpProfile?.username ?? '',
        hostKeyFingerprint: jumpProfile?.hostKeyFingerprint ?? '',
        credentialId: profile.jumpProfileId
      })
    : undefined
  return SshConnectionRouteSchema.parse({
    kind: 'ssh',
    host: profile.host,
    port: profile.port,
    username: profile.username,
    targetHost: profile.targetHost,
    targetPort: profile.targetPort ?? endpointPort,
    hostKeyFingerprint: profile.hostKeyFingerprint,
    credentialId: profile.id,
    ...(jump ? { jump } : {})
  })
}

// Why: a jump chain that loops back would dial forever; reject it at save time.
export function assertNoJumpCycle(profile: SshProfile, profiles: SshProfile[]): void {
  const byId = new Map(profiles.map((entry) => [entry.id, entry]))
  let current = profile.jumpProfileId
  const visited = new Set<string>([profile.id])
  while (current) {
    if (visited.has(current)) {
      throw new Error(
        'SSH connections cannot loop through each other. Choose a different jump host.'
      )
    }
    visited.add(current)
    const next = byId.get(current)
    if (!next) {
      return
    }
    current = next.jumpProfileId
  }
}
