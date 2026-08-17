import type {
  SkillInstallDestination,
  SkillInstallRequest,
  SkillInstallResult,
  SkillPlacementResult
} from '../../shared/skill-install-contract'
import type { SkillInstallProviderId } from '../../shared/skill-install-providers'
import type {
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import { startSpan, type ActiveSpan } from '../observability/tracer'
import { summarizeSkillBundleObservation } from './skill-bundle-observability-summary'
import { skillInstallFailureFromError } from './skill-install-operation-error'

const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MAX_OBSERVED_COUNT = 1_000_000
const MAX_OBSERVED_BYTES = 64 * 1024 * 1024

type SkillOperationPhase =
  | 'package'
  | 'upload'
  | 'finalization'
  | 'download'
  | 'transfer'
  | 'placement'
  | 'recovery'

type SkillPhaseStart = {
  phase: SkillOperationPhase
  platform?: 'darwin' | 'linux' | 'win32' | 'other'
  packageKind?: 'single' | 'bundle'
  transport?: 'download-grant' | 'staged-upload' | 'local-file' | 'runtime-rpc' | 'ssh-relay'
  destination?: 'startup' | 'transaction' | 'provider-placement' | 'remote-runtime' | 'global-ssh'
  compressedBytes?: number
  skillCount?: number
  provider?: SkillInstallProviderId
}

type SkillPhaseOutcome = {
  status?: 'complete' | 'partial' | 'installed' | 'unchanged' | 'removed' | 'skipped' | 'failed'
  errorCategory?: string
  fileCount?: number
  totalBytes?: number
  compressedBytes?: number
  chunkCount?: number
  scannedCount?: number
  recoveredCount?: number
  failureCount?: number
  orphanCount?: number
  rollbackCount?: number
  topology?: SkillPlacementResult['topology']
  aliasMechanism?: 'symlink' | 'junction' | 'filesystem' | 'none'
  copyFallbackCount?: number
  truncated?: boolean
}

export type SkillPhaseOperationSpan = {
  complete(outcome?: SkillPhaseOutcome): void
  fail(error: unknown): void
}

export type SkillInstallOperationSpan = {
  complete(result: SkillInstallResult): void
  fail(error: unknown): void
}

export type SkillBundleInstallOperationSpan = {
  complete(result: SkillBundleInstallResult): void
  fail(error: unknown): void
}

function safeLabel(value: string | undefined, fallback: string): string {
  return value && SAFE_LABEL.test(value) ? value : fallback
}

function boundedNumber(value: number, maximum = MAX_OBSERVED_COUNT): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), maximum) : 0
}

function platformLabel(destination?: SkillInstallDestination): string {
  if (destination?.scope === 'global' && destination.executionTarget?.kind === 'wsl') {
    return 'linux'
  }
  return ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other'
}

export function skillInstallDestinationLabel(destination: SkillInstallDestination): string {
  if (destination.scope === 'workspace') {
    return 'workspace'
  }
  return `global-${destination.executionTarget?.kind ?? 'host'}`
}

function failureLabel(
  error: unknown,
  fallback = 'skill-operation-unknown'
): { category: 'cancelled' | 'failed'; code: string } {
  const failure = skillInstallFailureFromError(error)
  const message = error instanceof Error ? error.message : undefined
  return {
    category: failure?.category === 'cancelled' ? 'cancelled' : 'failed',
    code: safeLabel(failure?.code ?? message, fallback)
  }
}

function setOutcome(span: ActiveSpan, outcome: SkillPhaseOutcome): void {
  for (const [key, value] of Object.entries(outcome)) {
    span.setAttribute(
      key,
      key === 'errorCategory' && typeof value === 'string'
        ? safeLabel(value, 'skill-operation-unknown')
        : typeof value === 'number'
          ? boundedNumber(value, key.endsWith('Bytes') ? MAX_OBSERVED_BYTES : MAX_OBSERVED_COUNT)
          : value
    )
  }
}

export function startSkillPhaseOperation(input: SkillPhaseStart): SkillPhaseOperationSpan {
  const span = startSpan(`skill.${input.phase}`, {
    attributes: {
      phase: input.phase,
      platform: input.platform ?? platformLabel(),
      ...(input.packageKind ? { packageKind: input.packageKind } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
      ...(input.destination ? { destination: safeLabel(input.destination, 'unknown') } : {}),
      ...(input.compressedBytes === undefined
        ? {}
        : { compressedBytes: boundedNumber(input.compressedBytes, MAX_OBSERVED_BYTES) }),
      ...(input.skillCount === undefined ? {} : { skillCount: boundedNumber(input.skillCount) }),
      ...(input.provider ? { provider: safeLabel(input.provider, 'unknown') } : {})
    }
  })
  return {
    complete(outcome = {}) {
      setOutcome(span, outcome)
      span.end()
    },
    fail(error) {
      const failure = failureLabel(error)
      span.setAttribute('status', failure.category)
      span.setAttribute('errorCategory', failure.code)
      if (failure.category === 'cancelled') {
        span.interrupt(failure.code)
      } else {
        span.fail(failure.code)
      }
    }
  }
}

export function recordSkillCapabilityAbsence(input: {
  capability:
    | 'skills.install.v1'
    | 'skills.install.bundle.v1'
    | 'skills.preview.bundle.v1'
    | 'skills.upload.v1'
  destination: 'remote-runtime' | 'global-ssh'
}): void {
  const span = startSpan('skill.capability', {
    attributes: {
      phase: 'capability',
      platform: platformLabel(),
      capability: safeLabel(input.capability, 'unknown'),
      destination: safeLabel(input.destination, 'unknown'),
      status: 'absent'
    }
  })
  span.end()
}

function recordPlacement(span: ActiveSpan, placement: SkillPlacementResult): void {
  span.addEvent('skill.placement', {
    provider: safeLabel(placement.provider, 'unknown'),
    topology: placement.topology,
    status: placement.status,
    errorCategory: safeLabel(placement.errorCategory, 'none')
  })
}

export function startSkillInstallOperation(
  request: SkillInstallRequest
): SkillInstallOperationSpan {
  const span = startSpan('skill.install', {
    attributes: {
      packageId: safeLabel(request.package.packageId, 'unknown'),
      versionId: safeLabel(request.package.versionId, 'unknown'),
      phase: 'install',
      platform: platformLabel(request.destination),
      destination: skillInstallDestinationLabel(request.destination),
      transport: request.ingress.kind,
      compressedBytes: request.package.compressedBytes
    }
  })
  return {
    complete(result) {
      span.setAttribute('status', result.status)
      span.setAttribute('placementCount', result.placements.length)
      span.setAttribute('conflictType', result.conflict?.kind ?? 'none')
      span.setAttribute(
        'aliasPlacementCount',
        result.placements.filter((placement) => placement.topology === 'provider-alias').length
      )
      span.setAttribute(
        'copyPlacementCount',
        result.placements.filter((placement) => placement.topology === 'independent-copy').length
      )
      for (const placement of result.placements) {
        recordPlacement(span, placement)
      }
      if (result.status === 'cancelled') {
        span.interrupt(safeLabel(result.errorCategory, 'skill-install-cancelled'))
      } else if (result.status === 'failed') {
        span.fail(safeLabel(result.errorCategory, 'skill-install-failed'))
      } else {
        span.end()
      }
    },
    fail(error) {
      const failure = failureLabel(error, 'skill-install-unknown')
      span.setAttribute('status', failure.category)
      span.setAttribute('errorCategory', failure.code)
      if (failure.category === 'cancelled') {
        span.interrupt(failure.code)
      } else {
        span.fail(failure.code)
      }
    }
  }
}

export function startSkillBundleInstallOperation(
  request: SkillBundleInstallRequest
): SkillBundleInstallOperationSpan {
  const span = startSpan('skill.install', {
    attributes: {
      packageId: safeLabel(request.package.packageId, 'unknown'),
      versionId: safeLabel(request.package.versionId, 'unknown'),
      packageKind: 'bundle',
      phase: 'install',
      platform: platformLabel(request.destination),
      destination: skillInstallDestinationLabel(request.destination),
      transport: request.ingress.kind,
      compressedBytes: request.package.compressedBytes,
      selectedSkillCount: boundedNumber(request.selectedSkillIds.length)
    }
  })
  return {
    complete(result) {
      span.setAttribute('status', result.status)
      const summary = summarizeSkillBundleObservation(result)
      for (const [key, value] of Object.entries(summary.attributes)) {
        span.setAttribute(key, boundedNumber(value))
      }
      for (const [category, count] of summary.errorCategories) {
        span.addEvent('skill.error-category', {
          category: safeLabel(category, 'skill-bundle-install-unknown'),
          count: boundedNumber(count)
        })
      }
      if (result.status === 'cancelled') {
        span.interrupt('skill-bundle-install-cancelled')
      } else if (result.status === 'failed') {
        span.fail('skill-bundle-install-failed')
      } else {
        span.end()
      }
    },
    fail(error) {
      const failure = failureLabel(error, 'skill-bundle-install-unknown')
      span.setAttribute('status', failure.category)
      span.setAttribute('errorCategory', failure.code)
      if (failure.category === 'cancelled') {
        span.interrupt(failure.code)
      } else {
        span.fail(failure.code)
      }
    }
  }
}
