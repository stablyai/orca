import { SCRYER_RULES } from '../../../../shared/scryer/rules'
import type {
  ScryerOperationExecutor,
  ScryerRuleDetail,
  ScryerRuleIndexEntry,
  ScryerRulesReadInput,
  ScryerRulesReadResult
} from '../types'
import { success } from './operation-result'

type ParsedRule = ScryerRuleDetail

const TAG_WORDS = [
  'boundary',
  'code',
  'component',
  'container',
  'edge',
  'external',
  'flow',
  'group',
  'hierarchy',
  'link',
  'model',
  'node',
  'operation',
  'process',
  'responsibility',
  'source',
  'symbol',
  'system',
  'workflow'
]

function titleFromBody(body: string): string {
  const firstSentence = body.split(/(?<=[.!?])\s+/)[0]?.trim()
  return firstSentence?.replace(/\.$/, '') ?? body.trim()
}

function tagsFor(body: string): string[] {
  const lower = body.toLowerCase()
  return TAG_WORDS.filter((tag) => lower.includes(tag))
}

function parseRules(): ParsedRule[] {
  const ruleLines = SCRYER_RULES.split('\n').filter((line) => /^\d+\.\s/.test(line.trim()))
  return ruleLines.map((line) => {
    const [, number = '0', body = line] = line.match(/^(\d+)\.\s+(.*)$/) ?? []
    const id = `rule-${number}`
    return {
      id,
      title: titleFromBody(body),
      tags: tagsFor(body),
      body: line.trim()
    }
  })
}

function indexOf(rules: ParsedRule[]): ScryerRuleIndexEntry[] {
  return rules.map(({ id, title, tags }) => ({ id, title, tags }))
}

function matchesTopic(rule: ParsedRule, topic: string): boolean {
  const normalized = topic.trim().toLowerCase()
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
  const wantsLinkRules = singular === 'link'
  return (
    rule.id.toLowerCase() === normalized ||
    rule.title.toLowerCase().includes(normalized) ||
    rule.title.toLowerCase().includes(singular) ||
    rule.tags.some(
      (tag) =>
        tag.toLowerCase().includes(normalized) ||
        tag.toLowerCase() === singular ||
        (wantsLinkRules && tag.toLowerCase() === 'edge')
    )
  )
}

export const rulesReadOperation: ScryerOperationExecutor<
  ScryerRulesReadInput,
  ScryerRulesReadResult
> = ({ input }) => {
  const rules = parseRules()
  const topic = input.topic?.trim()
  if (!topic) {
    return success({ result: { mode: 'index', rules: indexOf(rules) } })
  }
  const hits = rules.filter((rule) => matchesTopic(rule, topic))
  if (hits.length === 0) {
    return success({
      result: {
        mode: 'miss',
        topic,
        guidance: 'choose_topic_from_index',
        rules: indexOf(rules)
      }
    })
  }
  return success({
    result: {
      mode: 'topic',
      topic,
      rules: hits
    }
  })
}
