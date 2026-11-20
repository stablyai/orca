import type { EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { noInventedLinks, type TurnCheck } from './bot-orchestration-eval-grading'

type DeliveredText = { surface: string; text: string; questionTool?: true }
type AskFact = {
  pattern: RegExp
  what: string
  predicate?: string
  contradictions?: { pattern: RegExp; negated?: boolean }[]
}

function deliveredText(turn: EvalTurnOutcome): DeliveredText[] {
  const written = turn.writes.flatMap((write) => {
    const { method, params } = write
    let text: unknown
    if (method === 'bots.items.set') {
      text = params.comment
    } else if (method === 'bots.items.comment') {
      text = params.text
    } else if (method === 'connector.post' || method === 'connector.reply') {
      const args = params.args
      text = typeof args === 'object' && args !== null && 'text' in args ? args.text : params.text
    }
    return typeof text === 'string' && text.trim() ? [{ surface: method, text }] : []
  })
  return [
    ...(turn.reply.trim() ? [{ surface: 'reply', text: turn.reply }] : []),
    ...(turn.asks ?? []).map((text, index) => ({
      surface: `question ${index + 1}`,
      text,
      questionTool: true as const
    })),
    ...written
  ]
}

function words(text: string): string {
  return text.replace(/(?:orca|https?):\/\/[^\s)]+/gi, '')
}

function isAsk(payload: DeliveredText): boolean {
  return payload.questionTool === true || words(payload.text).includes('?')
}

function clauses(text: string): string[] {
  return words(text)
    .split(/[.!?;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

const WORKER_LINK = /orca:\/\/worker\/[^\s)\]>]+/gi
const UNSUPPORTED_EVIDENCE =
  /\b(?:tests?|checks?|ci|suite)\s+(?:(?:have|has|are|all)\s+)*(?:pass(?:ed|ing)?|fail(?:ed|ing)?|green|red)\b|\b(?:merged|deployed|approved|benchmarks?)\b|(?:src|tests|docs)\/[^\s)]+|[\w-]+\.(?:tsx?|jsx?|md)\b/i

const RELATIONSHIP_MODIFIER = String.raw`(?!(?:and|but|or|yet|although|because|while|until)\b)[\w'’-]+`
const RELATIONSHIP_NEGATOR = String.raw`(?:no(?:\s+longer)?|not(?!\s+(?:only|just|merely)\b)|never|without|cannot|(?:isn|aren|wasn|weren|doesn|don|didn|won|wouldn|shouldn|couldn|can|mustn)['’]t)`

function negatedRelationship(predicate: string): RegExp {
  return new RegExp(
    String.raw`\b${RELATIONSHIP_NEGATOR}\s+(?:${RELATIONSHIP_MODIFIER}\s+)*${predicate}\b|\b${predicate}\s+(?:no|none)(?:\s+${RELATIONSHIP_MODIFIER})*\s+(?:sav|writ|minutes?|hours?|days?|time)\w*\b`,
    'i'
  )
}

function matchesClaim(
  statement: string,
  pattern: RegExp,
  denial: RegExp,
  negated = false
): boolean {
  const repeated = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  )
  for (const match of statement.matchAll(repeated)) {
    if (denial.test(match[0]) === negated) {
      return true
    }
  }
  return false
}

function recommends(clause: string, choices: readonly RegExp[]): boolean {
  if (/\b(?:don['’]t|do not|never|cannot|can['’]t)\s+(?:recommend|suggest)/i.test(clause)) {
    return false
  }
  const recommendation =
    /\b(?:recommend(?:ation is)?|suggest|would (?:pick|choose)|['’]d (?:pick|choose))\s+(.+)/i.exec(
      clause
    )
  if (recommendation && !/^(?:nothing|neither|no\b|not\b)/i.test(recommendation[1]!)) {
    return choices.some((choice) => choice.test(recommendation[1]!))
  }
  const markedOption = /^(?:[-*]\s*)?(.+?)\s*\(recommended\)/i.exec(clause)
  return Boolean(markedOption && choices.some((choice) => choice.test(markedOption[1]!)))
}

/** Assertions bind each material fact to its subject/action/cost within one clause. */
export function selfContainedWorkerAsk(expected: {
  facts: AskFact[]
  choices: readonly [RegExp, RegExp]
  labels: RegExp[]
  workerLink?: string
}): TurnCheck {
  const facts = expected.facts.map((fact) => ({
    ...fact,
    denial: negatedRelationship(
      fact.predicate ?? '(?:block|prevent|stop|interrupt|take|cost|add|open|clip|cut|leave)\\w*'
    )
  }))
  return (turn) => {
    const payloads = deliveredText(turn)
    const asks = payloads.filter(isAsk)
    const failures: string[] = asks.length ? [] : ['never asked the owner']
    for (const payload of payloads) {
      const statements = clauses(payload.text)
      for (const fact of facts) {
        if (
          fact.contradictions?.some((claim) =>
            statements.some((statement) =>
              matchesClaim(statement, claim.pattern, fact.denial, claim.negated)
            )
          )
        ) {
          failures.push(`${payload.surface}: ask contradicts ${fact.what}`)
        }
      }
      if (UNSUPPORTED_EVIDENCE.test(words(payload.text))) {
        failures.push(`${payload.surface}: invents unsupported evidence`)
      }
      failures.push(
        ...noInventedLinks([])({ ...turn, reply: payload.text }).map(
          (failure) => `${payload.surface}: ${failure}`
        )
      )
    }
    for (const { surface, text } of asks) {
      const statements = clauses(text)
      if (!words(text).includes('?')) {
        failures.push(`${surface}: never asked the owner`)
      }
      const missing = facts.filter(
        (fact) =>
          !statements.some((statement) => matchesClaim(statement, fact.pattern, fact.denial))
      )
      failures.push(...missing.map((fact) => `${surface}: ask leaves out ${fact.what}`))
      if (
        !expected.choices.every((choice) => statements.some((statement) => choice.test(statement)))
      ) {
        failures.push(`${surface}: ask does not identify both choices`)
      }
      if (!statements.some((statement) => recommends(statement, expected.choices))) {
        failures.push(`${surface}: ask gives no recommendation of a stated choice`)
      }
      for (const label of expected.labels) {
        if (label.test(text)) {
          failures.push(`${surface}: ask passes on the worker's label ${label.source}`)
        }
      }
      const links = [...text.matchAll(WORKER_LINK)].map((match) => match[0])
      if (expected.workerLink && !links.includes(expected.workerLink)) {
        failures.push(`${surface}: ask leaves out the supplied worker link`)
      }
      if (links.some((link) => link !== expected.workerLink)) {
        failures.push(`${surface}: ask links a worker without a supplied link`)
      }
    }
    return failures
  }
}

export function briefAskWithoutWorker(maxSentencesBeforeQuestion: number): TurnCheck {
  return (turn) => {
    const payloads = deliveredText(turn)
    const asks = payloads.filter(isAsk)
    const failures: string[] = asks.length ? [] : ['never asked the owner']
    for (const { surface, text } of payloads) {
      if (/orca:\/\/worker\//i.test(text)) {
        failures.push(`${surface}: linked a worker when none was involved`)
      }
    }
    for (const { surface, text } of asks) {
      const before = words(text).split('?')[0]!
      if (!words(text).includes('?')) {
        failures.push(`${surface}: never asked the owner`)
      }
      const setup = Math.max(
        0,
        before.split(/[.!]\s+|\n{2,}/).filter((part) => part.trim()).length - 1
      )
      if (setup > maxSentencesBeforeQuestion) {
        failures.push(`${surface}: ask takes ${setup} sentences before its question`)
      }
    }
    return failures
  }
}
