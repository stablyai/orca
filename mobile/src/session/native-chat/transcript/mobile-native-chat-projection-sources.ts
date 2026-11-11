import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { getVerifiedNativeChatCommands } from '../../../../../src/shared/native-chat/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../../src/shared/native-chat/native-chat-command-envelope'
import {
  nativeChatCommandName,
  nativeChatCommandOutputParentId,
  surfaceNativeChatCommandOutputs
} from '../../../../../src/shared/native-chat/tools/native-chat-command-output'
import { isMobileNativeChatSource } from './mobile-native-chat-render-data'

export type MobileNativeChatProjectionSource = {
  raw: NativeChatMessage
  skill?: NativeChatMessage
  parentId?: string | null
  parentCommand?: string | null
  harness?: NativeChatMessage
}
type Source = MobileNativeChatProjectionSource

type JournalPosition = NonNullable<NativeChatMessage['journalPosition']>

function samePosition(left: JournalPosition, right: JournalPosition): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Own enumerable keys are used only to compare the same fields on both positions.
  const keys = Object.keys(left) as (keyof JournalPosition)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  )
}

function sameSource(left: NativeChatMessage, right: NativeChatMessage): boolean {
  if (left === right) {
    return true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Own enumerable keys are used only to compare the same fields on both messages.
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      if (!Object.hasOwn(right, key)) {
        return false
      }
      if (key === 'journalPosition' || key === 'foldedJournalPosition') {
        const a = left[key],
          b = right[key]
        return Object.is(a, b) || (a != null && b != null && samePosition(a, b))
      }
      return Object.is(left[key], right[key])
    })
  )
}

export function prepareMobileNativeChatSource(
  candidate: NativeChatMessage,
  commands: ReadonlySet<string>,
  before: Source | undefined
): Source {
  if (before && sameSource(before.raw, candidate)) {
    return before
  }
  if (!isMobileNativeChatSource(candidate)) {
    return { raw: candidate }
  }
  const skill = surfaceSkillInvocationUserTurns([candidate], commands)[0]!
  return { raw: candidate, skill, parentId: nativeChatCommandOutputParentId(skill) }
}

export function withMobileNativeChatHarness(
  source: Source,
  sources: ReadonlyMap<string, Source>,
  agent: AgentType,
  before: Source | undefined
): Source {
  if (!source.skill) {
    return source
  }
  const parent =
    source.parentId !== null && source.parentId !== undefined
      ? sources.get(source.parentId)
      : undefined
  const parentCommand = parent?.skill ? nativeChatCommandName(parent.skill) : null
  if (before?.skill === source.skill && before.parentCommand === parentCommand) {
    return source
  }
  const context =
    parent?.skill && parent.skill !== source.skill ? [source.skill, parent.skill] : [source.skill]
  return { ...source, parentCommand, harness: surfaceNativeChatCommandOutputs(context, agent)[0]! }
}

export function verifiedMobileNativeChatCommands(agent: AgentType): Set<string> {
  return new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
}

export function prepareMobileNativeChatSources(
  input: readonly NativeChatMessage[],
  agent: AgentType,
  previous?: { sources: ReadonlyMap<string, Source> }
): Map<string, Source> {
  const commands = verifiedMobileNativeChatCommands(agent)
  const sources = new Map<string, Source>()
  for (const candidate of input) {
    sources.set(
      candidate.id,
      prepareMobileNativeChatSource(candidate, commands, previous?.sources.get(candidate.id))
    )
  }
  for (const [id, source] of sources) {
    sources.set(id, withMobileNativeChatHarness(source, sources, agent, previous?.sources.get(id)))
  }
  return sources
}
