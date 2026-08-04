import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

function repair(locale, key, enValue, localeValue) {
  return repairTranslatedValue({ key, enValue, localeValue, locale })
}

const MOBILE_HERO_CONTINUE = 'auto.components.mobile.MobileHero.a8fb43cf1c'
const AGENT_CATALOG_CONTINUE = 'auto.lib.agent.catalog.9e2a9bb87b'
const CONTINUE_IN_NEW_SESSION = 'components.agentSessionContinuation.continueInNewSession'
const SSH_PERSISTENCE_DESCRIPTION =
  'auto.components.sidebar.AddRemoteHostDialog.sshPersistenceDefault'
const SSH_ADVANCED = 'auto.components.sidebar.AddRemoteHostDialog.advanced'
const REVIEW_AGENT_PROMPT = 'auto.components.right.sidebar.ChecksPanel.ed3f79c031'
const REVIEW_AGENT_RESULT = 'auto.components.right.sidebar.ChecksPanel.f273f2271c'
const REPO_ICON_EMOJI = 'auto.components.settings.RepositoryIconPicker.emojiTooLongForRepoIcon'

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

describe('localized prose introduced on main', () => {
  it('does not rewrite localized terminal and agent prose as Latin product labels', () => {
    expect(
      repair(
        'ko',
        SSH_PERSISTENCE_DESCRIPTION,
        'Remote terminals on this host stay alive until you end them or reset the relay.',
        '이 호스트의 원격 터미널은 종료하거나 릴레이를 재설정할 때까지 계속 실행됩니다.'
      )
    ).toBe('이 호스트의 원격 터미널은 종료하거나 릴레이를 재설정할 때까지 계속 실행됩니다.')
    expect(
      repair(
        'ko',
        REVIEW_AGENT_PROMPT,
        'Review the prompt before starting an agent.',
        '에이전트를 시작하기 전에 프롬프트를 확인하세요.'
      )
    ).toBe('에이전트를 시작하기 전에 프롬프트를 확인하세요.')
    expect(repair('zh', REVIEW_AGENT_RESULT, 'Started the agent.', '已启动智能体。')).toBe(
      '已启动智能体。'
    )
  })

  it('keeps the exact Add Remote Host advanced labels from main', () => {
    expect(repair('ja', SSH_ADVANCED, 'Advanced', '詳細')).toBe('詳細')
    expect(repair('zh', SSH_ADVANCED, 'Advanced', 'Advanced')).toBe('Advanced')
  })

  it('keeps localized repo terminology in newly added explanatory copy', () => {
    expect(
      repair(
        'zh',
        REPO_ICON_EMOJI,
        'This emoji cannot be used as a repo icon.',
        '此表情符号无法用作仓库图标。'
      )
    ).toBe('此表情符号无法用作仓库图标。')
  })
})
