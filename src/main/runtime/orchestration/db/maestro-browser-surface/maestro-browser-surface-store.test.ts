import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MaestroBrowserProfileConsentGrantRequestSchema,
  MaestroBrowserSurfaceRequestSchema
} from '../../../../../shared/maestro-browser-surface'
import { SCHEMA_VERSION } from '../contract-constants'
import { OrchestrationDb } from '../orchestration-db'

const request = MaestroBrowserSurfaceRequestSchema.parse({
  schema_version: 1,
  protocol: 'maestro-browser-surface/v1',
  request_id: 'request-1',
  workspace: {
    repository_id: 'repo-1',
    execution_host_id: 'local',
    workspace_key: 'folder:workspace-1',
    run_id: 'run-1'
  },
  actor: {
    actor_id: 'coordinator-1',
    kind: 'coordinator',
    authenticated: true,
    session_id: 'session-1'
  },
  coordinator_generation: 1,
  task_id: 'ORC-07B',
  attempt_id: 'attempt-orc-07b-001',
  agent_id: 'agent-1',
  url: 'https://user:secret@example.com/validation?token=secret#fragment',
  title: 'Browser validation',
  profile_id: null,
  requested_visibility: 'visible',
  viewport: { width: 1920, height: 1080, device_scale_factor: 1 },
  retention: 'release_when_settled',
  ownership: 'harness',
  evidence: {
    route_or_component: 'Maestro browser surface',
    state: 'visible validation attached light',
    theme: 'light',
    source_revision: 'revision-1',
    capture_mode: 'native-viewport'
  }
})

describe('Maestro browser surface store', () => {
  let database: OrchestrationDb

  beforeEach(() => {
    database = new OrchestrationDb(':memory:')
  })

  afterEach(() => database.close())

  it('reserves one exact page for repeated task and attempt requests', () => {
    const first = database.reserveMaestroBrowserSurface(request)
    const replay = database.reserveMaestroBrowserSurface(request)

    expect(replay.receipt.surface_id).toBe(first.receipt.surface_id)
    expect(replay.receipt.browser_page_id).toBe('maestro-request-1')
    expect(replay.receipt.url).toBe('https://example.com/validation')
    expect(replay.navigationUrl).toContain('token=secret')
  })

  it('rejects request id reuse with different authority', () => {
    database.reserveMaestroBrowserSurface(request)
    expect(() =>
      database.reserveMaestroBrowserSurface({ ...request, agent_id: 'agent-2' })
    ).toThrow('another identity')
  })

  it('updates lifecycle receipts without changing durable identity', () => {
    const reserved = database.reserveMaestroBrowserSurface(request)
    const updated = database.updateMaestroBrowserSurface(
      reserved.receipt.surface_id,
      (receipt) => ({
        ...receipt,
        state: 'retained',
        observed_visibility: 'visible'
      })
    )

    expect(updated.receipt).toMatchObject({
      surface_id: reserved.receipt.surface_id,
      request_id: request.request_id,
      state: 'retained',
      observed_visibility: 'visible'
    })
    expect(database.listReconcilableMaestroBrowserSurfaces()).toHaveLength(1)
  })

  it('reopens an exact host-issued profile consent and persists its revocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-browser-profile-consent-'))
    const databasePath = join(directory, 'orchestration.sqlite')
    database.close()
    database = new OrchestrationDb(databasePath)
    database.db.exec('DROP TABLE maestro_browser_profile_consents')
    database.db.pragma('user_version = 35')
    database.close()
    database = new OrchestrationDb(databasePath)
    expect(database.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const grantRequest = MaestroBrowserProfileConsentGrantRequestSchema.parse({
      schema_version: 1,
      protocol: 'maestro-browser-profile-consent/v1',
      workspace: request.workspace,
      profile_id: 'profile-1',
      task_id: request.task_id,
      attempt_id: request.attempt_id,
      expires_at: '2099-08-31T20:00:00.000Z'
    })
    const granted = database.grantMaestroBrowserProfileConsent(
      grantRequest,
      {
        actor_id: 'human-1',
        kind: 'user',
        authenticated: true,
        session_id: 'human-session-1'
      },
      new Date('2026-08-31T20:00:00.000Z')
    )
    database.close()
    database = new OrchestrationDb(databasePath)

    expect(database.getMaestroBrowserProfileConsent(granted, request.workspace)).toEqual(granted)
    expect(
      database.getMaestroBrowserProfileConsent(
        { ...granted, expires_at: '2099-09-01T20:00:00.000Z' },
        request.workspace
      )
    ).toBeUndefined()

    const revoked = database.revokeMaestroBrowserProfileConsent(
      {
        schema_version: 1,
        protocol: 'maestro-browser-profile-consent/v1',
        workspace: request.workspace,
        consent_id: granted.consent_id
      },
      new Date('2026-08-31T21:00:00.000Z')
    )
    database.close()
    database = new OrchestrationDb(databasePath)

    expect(revoked.revoked_at).toBe('2026-08-31T21:00:00.000Z')
    expect(database.getMaestroBrowserProfileConsent(revoked, request.workspace)).toEqual(revoked)
    database.close()
    rmSync(directory, { recursive: true, force: true })
    database = new OrchestrationDb(':memory:')
  })
})
