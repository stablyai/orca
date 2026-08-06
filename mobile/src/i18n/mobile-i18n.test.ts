import { afterEach, describe, expect, it } from 'vitest'
import appConfig from '../../app.json'

import {
  createMobileTranslator,
  getActiveMobileUiLanguageTag,
  mobileI18n,
  normalizeMobileUiLocale,
  selectPreferredMobileUiLocale,
  shouldReloadForMobileLocaleChange,
  t,
  type MobileUiLocale
} from './mobile-i18n'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('mobile i18n', () => {
  it.each([
    ['es-MX', 'es'],
    ['ja-JP', 'ja'],
    ['ko_KR', 'ko'],
    ['zh-Hans-CN', 'zh'],
    ['zh-Hant-TW', 'en'],
    ['zh-MO', 'en'],
    ['fr-FR', 'en']
  ] satisfies [string, MobileUiLocale][])('normalizes %s to %s', (input, expected) => {
    expect(normalizeMobileUiLocale(input)).toBe(expected)
  })

  it('selects the first supported locale from the ordered preferences', () => {
    expect(selectPreferredMobileUiLocale(['fr-FR', 'es-MX'])).toBe('es')
    expect(selectPreferredMobileUiLocale(['zh-Hant', 'ja-JP'])).toBe('ja')
    expect(selectPreferredMobileUiLocale(['zh-MO', 'ko-KR'])).toBe('ko')
  })

  it('reloads only when the effective locale changes', () => {
    expect(shouldReloadForMobileLocaleChange('en', ['fr-FR', 'es-MX'])).toBe(true)
    expect(shouldReloadForMobileLocaleChange('es', ['fr-FR', 'es-MX'])).toBe(false)
  })

  it('reads and interpolates the English catalog', async () => {
    await mobileI18n.changeLanguage('en')
    expect(
      t('mobileNativeChatPermission.allowPermission', {
        permissionName: 'Camera'
      })
    ).toBe('Allow Camera?')
  })

  it('keeps prefixed translators on the active locale', async () => {
    await mobileI18n.changeLanguage('es')
    expect(createMobileTranslator('task')('gitHub')).toBe('GitHub')
  })

  it('exposes the effective BCP 47 language tag for embedded documents', async () => {
    await mobileI18n.changeLanguage('zh')

    expect(getActiveMobileUiLanguageTag()).toBe('zh-Hans')
  })

  it('enables localized native metadata on iOS', () => {
    expect(appConfig.expo.ios.infoPlist.CFBundleAllowMixedLocalizations).toBe(true)
  })

  it.each([
    ['es', 'Por hacer'],
    ['ja', '未着手'],
    ['ko', '할 일'],
    ['zh', '待办']
  ] satisfies [MobileUiLocale, string][])(
    'uses reviewed task-status copy in %s',
    async (locale, expected) => {
      await mobileI18n.changeLanguage(locale)
      expect(t('mobileWorkspaceStatuses.todo')).toBe(expected)
    }
  )

  it('falls back from polluted Simplified Chinese GitLab copy', async () => {
    await mobileI18n.changeLanguage('zh')
    expect([t('task.gitLabFilter'), t('task.gitLabView'), t('task.gitLabTodo')]).toEqual([
      'GitLab Filter',
      'GitLab View',
      'GitLab todo'
    ])
  })

  it('keeps generated terminal shortcut labels canonical in translated locales', async () => {
    await mobileI18n.changeLanguage('zh')
    const {
      buildTerminalShortcutKey,
      TERMINAL_SHORTCUT_MODIFIER_LABELS,
      TERMINAL_SHORTCUT_SPECIAL_KEYS
    } = await import('../terminal/terminal-accessory-keys')

    expect(TERMINAL_SHORTCUT_MODIFIER_LABELS).toEqual({
      ctrl: 'Ctrl',
      alt: 'Alt',
      shift: 'Shift'
    })
    expect(TERMINAL_SHORTCUT_SPECIAL_KEYS.find((key) => key.id === 'pageDown')?.label).toBe('PgDn')
    expect(buildTerminalShortcutKey({ key: 'pageDown', modifiers: ['shift'] })?.label).toBe(
      'Shift+PgDn'
    )
  })

  it('renders Japanese branch-readiness guidance in Japanese', async () => {
    await mobileI18n.changeLanguage('ja')

    expect([
      t('mobileHostedReviewCreateIntent.resolveStage'),
      t('useMobileCreatePrRunner.check'),
      t('mobileCreatePrAction.branch', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.branch', { reviewType: 'PR' }),
      t('mobilePrCreate.push', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.authenticate', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.sync', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.publish', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.check', {
        reviewType: 'PR'
      }),
      t('mobilePrCreate.commit', {
        reviewType: 'PR'
      })
    ]).toEqual([
      'PR を作成する前に、変更を解決するかステージングしてください。',
      'PR を作成する前にブランチをチェックアウトしてください。',
      'このブランチはまだ PR の準備ができていません。',
      'このブランチはまだ PR の準備ができていません。',
      'PR を作成する前にベース ブランチをプッシュしてください。',
      '認証してから PR を作成してください。',
      'このブランチを同期してから PR を作成してください。',
      'コミットを公開してから PR を作成してください。',
      'ブランチをチェックアウトしてから PR を作成してください。',
      '変更をコミットしてから PR を作成してください。'
    ])
  })

  it('keeps Japanese composite action grammar in the active locale', async () => {
    await mobileI18n.changeLanguage('ja')

    expect([
      t('hostedReview.mergeConfirm', {
        action: t('task.merge'),
        target: t('task.pr'),
        number: 42
      }),
      t('hostedReview.stateChangeTitle', {
        action: t('task.close'),
        target: t('task.pullRequest')
      }),
      t('task.action', {
        actionVerb: t('task.close'),
        taskKindLabel: t('task.pullRequestMessage')
      })
    ]).toEqual(['PR #42 をマージしますか？', 'PRを閉じる', 'PRを閉じる'])
  })

  it('renders Spanish branch counts with correct noun order and Git terminology', async () => {
    await mobileI18n.changeLanguage('es')

    expect([
      t('mobileBranchCompare.changedFileCountFiles', { changedFileCount: 2 }),
      t('mobileBranchCompare.commitCountCommit', { commitCount: 1 }),
      t('mobileBranchCompare.commitCountCommits', { commitCount: 2 })
    ]).toEqual(['2 archivos', '1 commit', '2 commits'])
  })

  it.each([
    [
      'es',
      [
        'No ejecutar',
        'Confiar siempre y ejecutar',
        'No ejecutar',
        'Confiar siempre y ejecutar',
        'Ejecutar'
      ]
    ],
    ['ja', ['実行しない', '常に信頼して実行', '実行しない', '常に信頼して実行', '実行']],
    ['ko', ['실행 안 함', '항상 신뢰하고 실행', '실행 안 함', '항상 신뢰하고 실행', '실행']],
    ['zh', ['不执行', '始终信任并执行', '不执行', '始终信任并执行', '执行']]
  ] as const)('uses software-execution wording for setup trust in %s', async (locale, expected) => {
    await mobileI18n.changeLanguage(locale)

    expect([
      t('task.do'),
      t('task.always'),
      t('setupHookTrustDrawer.do'),
      t('setupHookTrustDrawer.always'),
      t('newWorktreeModal.run')
    ]).toEqual(expected)
  })

  it('uses standard Simplified Chinese Git mutation labels', async () => {
    await mobileI18n.changeLanguage('zh')

    expect([
      t('mobileSourceControlScreenState.noBranch'),
      t('mobileSourceControlActions.pull'),
      t('mobileSourceControlActions.push'),
      t('mobileSourceControlPrimaryAction.forcePush')
    ]).toEqual(['无分支', '拉取', '推送', '强制推送'])
  })

  it('falls back for exact neutral values and localizes notification channels', async () => {
    await mobileI18n.changeLanguage('es')

    expect([
      t('mobileDictationSetupSheet.open'),
      t('mobileMarkdown.x'),
      t('localNotificationScheduling.desktopNotifications')
    ]).toEqual(['OpenAI API', '[x]', 'Notificaciones de escritorio'])
  })

  it.each([
    ['es', ['Omitido', 'Publicando rama...']],
    ['ja', ['スキップ済み', 'ブランチを公開しています...']],
    ['ko', ['건너뜀', '브랜치 게시 중...']],
    ['zh', ['已跳过', '正在发布分支...']]
  ] satisfies [MobileUiLocale, string[]][])(
    '%s uses Git operation terminology',
    async (locale, expected) => {
      await mobileI18n.changeLanguage(locale)
      expect([
        t('prChecksPresentation.skipped'),
        t('mobileHostedReviewCreateIntent.publishing')
      ]).toEqual(expected)
    }
  )

  it('uses Git push and pull terminology in Japanese', async () => {
    await mobileI18n.changeLanguage('ja')
    expect([
      t('mobileSourceControlPrimaryAction.push'),
      t('mobileSourceControlPrimaryAction.pull'),
      t('mobileSourceControlActions.push'),
      t('mobileSourceControlActions.pull')
    ]).toEqual(['プッシュ', 'プル', 'プッシュ', 'プル'])
  })

  it.each([
    ['es', ['Checkout completo', 'Los commits locales se perderían; haz pull en su lugar']],
    ['ja', ['フルチェックアウト', 'ローカルコミットが失われます。代わりにプルしてください']],
    ['ko', ['전체 체크아웃', '로컬 커밋이 손실됩니다. 대신 풀하세요']],
    ['zh', ['完整检出', '本地提交将丢失；请改用拉取']]
  ] satisfies [MobileUiLocale, string[]][])(
    '%s uses accurate checkout and pull terminology',
    async (locale, expected) => {
      await mobileI18n.changeLanguage(locale)
      expect([t('task.full'), t('mobileSourceControlActions.local')]).toEqual(expected)
    }
  )

  it.each([
    ['es', ['Sin comprobaciones', 'En staging', 'Nota de revisión']],
    ['ja', ['チェックなし', 'ステージ済み', 'レビューメモ']],
    ['ko', ['체크 없음', '스테이징됨', '리뷰 노트']],
    ['zh', ['没有检查项', '已暂存', '审查备注']]
  ] satisfies [MobileUiLocale, string[]][])(
    'preserves source-control glossary terms in %s',
    async (locale, expected) => {
      await mobileI18n.changeLanguage(locale)
      expect([
        t('prChecksPresentation.no'),
        t('mobileDiffReviewQueue.staged'),
        t('mobileDiffReviewDrawers.reviewNote')
      ]).toEqual(expected)
    }
  )
})
