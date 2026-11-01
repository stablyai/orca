export const CROSS_LOCALE_KEY_OVERRIDES = {
  'components.native-chat.resumeInNewChat.exitUnconfirmedFromTerminal': {
    de: 'Orca konnte nicht bestätigen, dass {{agent}} in diesem Terminal beendet wurde. Beende {{agent}} hier und versuche diese Aktion erneut.',
    es: 'Orca no pudo confirmar que {{agent}} se detuvo en esta terminal. Sal de {{agent}} aquí y vuelve a intentar esta acción.',
    fr: 'Orca n’a pas pu confirmer l’arrêt de {{agent}} dans ce terminal. Quittez {{agent}} ici, puis réessayez cette action.',
    ja: 'Orca は、このターミナルで {{agent}} が停止したことを確認できませんでした。ここで {{agent}} を終了してから、この操作をもう一度試してください。',
    ko: 'Orca가 이 터미널에서 {{agent}}이(가) 중지되었는지 확인할 수 없습니다. 여기서 {{agent}}을(를) 종료한 다음 이 작업을 다시 시도하세요.',
    pt: 'O Orca não pôde confirmar que {{agent}} parou neste terminal. Encerre {{agent}} aqui e tente esta ação novamente.',
    ru: 'Orca не удалось подтвердить, что {{agent}} остановлен в этом терминале. Завершите {{agent}} здесь и повторите это действие.',
    tr: 'Orca, {{agent}} uygulamasının bu terminalde durduğunu doğrulayamadı. Burada {{agent}} uygulamasından çıkın ve bu işlemi yeniden deneyin.',
    zh: 'Orca 无法确认 {{agent}} 已在此终端中停止。请在此处退出 {{agent}}，然后重试此操作。',
    'zh-Hant':
      'Orca 無法確認 {{agent}} 已在此終端機中停止。請在此處結束 {{agent}}，然後重試此操作。'
  },
  'components.native-chat.resumeInNewChat.exitUnconfirmed': {
    de: 'Orca konnte nicht bestätigen, dass {{agent}} beendet wurde. Beende {{agent}} in seinem Terminal und versuche diese Aktion erneut.',
    es: 'Orca no pudo confirmar que {{agent}} se detuvo. Sal de {{agent}} en su terminal y vuelve a intentar esta acción.',
    fr: 'Orca n’a pas pu confirmer l’arrêt de {{agent}}. Quittez {{agent}} dans son terminal, puis réessayez cette action.',
    ja: 'Orca は {{agent}} が停止したことを確認できませんでした。{{agent}} を実行中のターミナルで終了してから、この操作をもう一度試してください。',
    ko: 'Orca가 {{agent}}이(가) 중지되었는지 확인할 수 없습니다. 해당 터미널에서 {{agent}}을(를) 종료한 다음 이 작업을 다시 시도하세요.',
    pt: 'O Orca não pôde confirmar que {{agent}} parou. Encerre {{agent}} no terminal em que está sendo executado e tente esta ação novamente.',
    ru: 'Orca не удалось подтвердить, что {{agent}} остановлен. Завершите {{agent}} в его терминале и повторите это действие.',
    tr: 'Orca, {{agent}} uygulamasının durduğunu doğrulayamadı. {{agent}} uygulamasından çalıştığı terminalde çıkın ve bu işlemi yeniden deneyin.',
    zh: 'Orca 无法确认 {{agent}} 已停止。请在其所在的终端中退出 {{agent}}，然后重试此操作。',
    'zh-Hant':
      'Orca 無法確認 {{agent}} 已停止。請在其所在的終端機中結束 {{agent}}，然後重試此操作。'
  },
  'components.tab.bar.SortableTabContextMenu.showAsTerminal': {
    de: 'Als Terminal anzeigen',
    es: 'Mostrar como terminal',
    fr: 'Afficher en terminal',
    ja: 'ターミナルとして表示',
    ko: '터미널로 표시',
    pt: 'Mostrar como terminal',
    ru: 'Показать как терминал',
    tr: 'Terminal olarak göster',
    zh: '以终端显示',
    'zh-Hant': '以終端機顯示'
  },
  'components.tab.bar.SortableTabContextMenu.switchToTerminalView': {
    de: 'Mit Terminal-Agenten fortfahren',
    es: 'Continuar con el agente de terminal',
    fr: 'Continuer avec l’agent de terminal',
    ja: 'ターミナル Agent で続ける',
    ko: '터미널 에이전트로 계속하기',
    pt: 'Continuar com o agente de terminal',
    ru: 'Продолжить с агентом в терминале',
    tr: 'Terminal ajanıyla devam et',
    zh: '使用终端智能体继续',
    'zh-Hant': '使用終端機代理程式繼續'
  },
  // The live status describes ongoing reasoning; the composer option names the feature.
  'components.native-chat.status.thinking': {
    zh: '思考中',
    ja: '思考中',
    ko: '생각 중',
    fr: 'Réflexion en cours',
    es: 'Pensando'
  },
  'auto.components.feature.wall.WorkbenchAnimatedVisual.633a91e358': { zh: '思考中…' },
  'auto.components.GitLabItemDialog.4168eb2c51': {
    zh: '解决',
    ja: '解決'
  },
  'auto.components.TaskPage.524f095d55': {
    zh: '待评审',
    ja: 'レビュー待ち'
  },
  'auto.components.TaskPage.9cd11ba218': {
    zh: 'Jira',
    ja: 'Jira'
  },
  // Search-match fragment concatenated flush after the visible theme count; MT dropped the
  // en leading space that separates it from the count.
  'auto.components.settings.SettingsFormControls.c822571b2e': {
    zh: ' 匹配“{{value0}}”',
    ja: ' 「{{value0}}」に一致'
  },
  // Total-count fragment on the same row; without the separator "Showing 30 of 30"
  // rendered as "表示中 3030の" / "显示中 3030 的".
  'auto.components.settings.SettingsFormControls.cb330ef7f8': {
    zh: '/{{value0}}',
    ja: '/{{value0}}'
  },
  // ko/zh put the quoted query before the verb phrase; MT tends to move it after.
  'auto.components.settings.Settings.noSettingsFoundForQuery': {
    ko: '"{{value0}}"에 대한 설정을 찾을 수 없습니다.',
    zh: '找不到“{{value0}}”的设置'
  },
  'auto.components.settings.TasksPane.6b23a34f6d': {
    zh: 'Jira',
    ja: 'Jira'
  },
  'auto.components.settings.integrations.search.03a7b275be': {
    zh: 'ADO',
    ja: 'ADO'
  },
  'auto.components.settings.integrations.search.129fc59aa8': {
    zh: 'Gitea',
    ja: 'Gitea'
  },
  'auto.components.settings.integrations.search.20540996ef': {
    zh: '凭据',
    ja: '認証情報'
  },
  'auto.components.settings.integrations.search.581844769a': {
    zh: 'MR',
    ja: 'MR'
  },
  'auto.components.settings.integrations.search.617603509b': {
    zh: 'Jira 集成',
    ja: 'Jira 連携'
  },
  'auto.components.settings.integrations.search.67a2a0e868': {
    zh: 'Bitbucket 集成',
    ja: 'Bitbucket 連携'
  },
  'auto.components.settings.integrations.search.aab86d64e5': {
    zh: 'Gitea 集成',
    ja: 'Gitea 連携'
  },
  'auto.components.settings.integrations.search.af6611fa6e': {
    zh: 'Azure DevOps 集成',
    ja: 'Azure DevOps 連携'
  },
  'auto.components.settings.integrations.search.b027b4b318': {
    zh: 'Linear 集成',
    ja: 'Linear 連携'
  },
  'auto.components.settings.integrations.search.b40cbe5de4': {
    zh: 'glab',
    ja: 'glab'
  },
  'auto.components.settings.integrations.search.b50b71ef9d': {
    zh: 'GitLab 集成',
    ja: 'GitLab 連携'
  },
  'auto.components.settings.integrations.search.b79c21bd42': {
    zh: 'GitHub',
    ja: 'GitHub'
  },
  'auto.components.settings.integrations.search.c450244ad7': {
    zh: '集成',
    ja: '連携'
  },
  'auto.components.settings.integrations.search.e1263dd748': {
    zh: 'Jira',
    ja: 'Jira'
  },
  'auto.components.settings.integrations.search.f16e41cc72': {
    zh: 'GitHub 集成',
    ja: 'GitHub 連携'
  },
  'auto.components.sidebar.workspace.status.409528031f': {
    zh: '评审',
    ja: 'レビュー'
  },
  'auto.components.sidebar.workspace.status.6c1efa2cf8': {
    zh: '评审中',
    ja: 'レビュー中'
  },
  'auto.components.sidebar.workspace.status.caebe3c10f': {
    zh: 'Conductor 评审',
    ja: 'Conductor レビュー'
  },
  'auto.components.sidebar.worktree.list.groups.6798dc7c94': {
    zh: '评审中',
    ja: 'レビュー中'
  },
  'auto.components.status.bar.WorkspaceSpaceCompactPanel.c361440dc0': {
    zh: '测试版',
    ja: 'ベータ'
  },
  'auto.hooks.useSettingsNavigationMetadata.40d80bad8a': {
    zh: '测试版',
    ja: 'ベータ'
  },
  // Issue/PR state picker; it sits beside 已关闭, so 进行中 is a different state.
  'auto.components.PullRequestPage.7b8f6bf6d8': {
    zh: '开放'
  },
  // This "Open" is the button that opens the config file, not an issue state.
  'auto.components.settings.McpConfigFileRow.e720c139cd': {
    zh: '打开'
  },
  // Terminal cursor-color group: the on-screen cursor, not the Cursor editor.
  'auto.components.settings.TerminalWindowSection.c9e1fdf42f': {
    ko: '커서',
    zh: '光标'
  },
  'auto.components.onboarding.ThemeStep.ab2a583a97': {
    ko: '커서',
    zh: '光标'
  },
  // Tailwind swatch labels: bare 天空 (the sky), 锌 and 空 (the metal, the sky) are not colors.
  'auto.components.sidebar.workspace.status.6437a8c253': {
    zh: '天蓝',
    ja: '空色'
  },
  'auto.components.sidebar.workspace.status.caabd5ca85': {
    zh: '锌灰'
  }
}
