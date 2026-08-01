import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

function repair(locale, key, enValue, localeValue) {
  return repairTranslatedValue({ key, enValue, localeValue, locale })
}

const MOBILE_HERO_CONTINUE = 'auto.components.mobile.MobileHero.a8fb43cf1c'
const AGENT_CATALOG_CONTINUE = 'auto.lib.agent.catalog.9e2a9bb87b'
const CONTINUE_IN_NEW_SESSION = 'components.agentSessionContinuation.continueInNewSession'

describe('Continue action vs Continue agent', () => {
  it('translates the bare Continue button instead of preserving the brand', () => {
    expect(shouldPreserveEnglishValue('Continue', MOBILE_HERO_CONTINUE)).toBe(false)
    expect(repair('zh', MOBILE_HERO_CONTINUE, 'Continue', 'Continue')).toBe('继续')
    expect(repair('ja', MOBILE_HERO_CONTINUE, 'Continue', 'Continue')).toBe('続ける')
    expect(repair('ko', MOBILE_HERO_CONTINUE, 'Continue', 'Continue')).toBe('계속')
  })

  it('keeps the Continue agent catalog entry in Latin', () => {
    expect(shouldPreserveEnglishValue('Continue', AGENT_CATALOG_CONTINUE)).toBe(true)
    expect(repair('zh', AGENT_CATALOG_CONTINUE, 'Continue', 'Continue')).toBe('Continue')
  })

  it('does not revert the continue verb in "Continue in New Session"', () => {
    expect(
      repair('zh', CONTINUE_IN_NEW_SESSION, 'Continue in New Session…', '在新会话中继续…')
    ).toBe('在新会话中继续…')
    expect(repair('es', CONTINUE_IN_NEW_SESSION, 'Continue in New Session…', 'Continuar…')).toBe(
      'Continuar…'
    )
  })

  it('still reverts the Continue agent name inside prose', () => {
    expect(
      repair(
        'zh',
        'auto.components.settings.AgentsPane.example',
        'Continue is enabled.',
        '继续已启用。'
      )
    ).toBe('Continue已启用。')
  })
})

describe('ja AI agent spacing', () => {
  it('splits AIagent glued by the エージェント brand revert', () => {
    expect(
      repair(
        'ja',
        'auto.components.right.sidebar.source.control.ai.push.failure.launch.a8b97d2318',
        'Started an AI agent for the push failure.',
        'プッシュ失敗用のAIエージェントを起動しました。'
      )
    ).toBe('プッシュ失敗用の AI agent を起動しました。')
  })

  it('splits the plural form too', () => {
    expect(
      repair(
        'ja',
        'auto.components.right.sidebar.source.control.ai.push.failure.launch.9bbd9077a2',
        'No enabled AI agents. Configure agents in Settings.',
        '有効なAIエージェントがありません。設定でエージェントを構成してください。'
      )
    ).toBe('有効な AI agents がありません。設定で agents を構成してください。')
  })

  it('leaves already-spaced values untouched', () => {
    const spaced = '保存された AI agent は使用できません。'
    expect(
      repair(
        'ja',
        'auto.components.right.sidebar.source.control.ai.commit.failure.launch.d481ab22f9',
        'Saved AI agent is unavailable.',
        spaced
      )
    ).toBe(spaced)
  })
})

describe('zh agent-detection wording', () => {
  it('keeps 未检测到 instead of the 已检测 status label', () => {
    expect(
      repair(
        'zh',
        'components.agentSessionContinuation.noAgents',
        'No enabled Agents were detected on this workspace host.',
        '未在此工作区主机上检测到已启用的智能体。'
      )
    ).toBe('此工作区主机上未检测到已启用的 Agents。')
    expect(
      repair(
        'zh',
        'components.agentSessionContinuation.agentUnavailable',
        '{{agent}} was not detected on this workspace host.',
        '未在此工作区主机上检测到 {{agent}}。'
      )
    ).toBe('此工作区主机上未检测到 {{agent}}。')
  })
})
