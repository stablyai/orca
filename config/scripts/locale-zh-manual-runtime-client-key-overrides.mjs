// Human-reviewed Simplified Chinese for shared runtime libraries, web client, and native chat.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_RUNTIME_CLIENT_KEY_OVERRIDES = {
  // Shared libraries, web client, and native chat.
  'auto.lib.agent.skill.cli.prerequisite.e99d7dc36f': { zh: 'Orca CLI 注册需要处理' },
  'auto.lib.fix.checks.agent.launch.4c7f783a7a': {
    zh: '已保存的检查修复智能体在此工作区主机上不可用。'
  },
  'auto.lib.fix.checks.agent.launch.9f00d7df0c': {
    zh: '修复检查的提示词为空。请更新源代码管理 AI 设置。'
  },
  'auto.lib.floating.workspace.tab.creation.f3785eddc2': { zh: '新建浏览器标签页' },
  'auto.lib.launch.agent.background.session.4ca0651d56': {
    zh: '自动化提示词未发送。请打开工作区并粘贴。'
  },
  'auto.lib.launch.work.item.direct.8bc45efdbc': { zh: '无法解析 PR 源分支引用。' },
  'auto.lib.orchestration.usage.examples.5e0d489fe1': { zh: '移交进行中的任务' },
  'auto.lib.orchestration.usage.examples.bddc4c09b8': { zh: '运行分阶段工作流' },
  'auto.lib.pr.comment.audience.a7150a17bc': { zh: '真人' },
  'auto.lib.pr.comment.audience.empty.human': { zh: '暂无真人评论。' },
  'auto.lib.source.control.agent.action.plan.46f1a2c9bd': { zh: '命令输入为空。' },
  'auto.lib.source.control.generation.plan.dc480d5897': { zh: '命令输入为空。' },
  'auto.lib.sparse.preset.draft.5915a0a1f6': {
    zh: '请使用仓库相对目录，不要使用根目录、绝对路径或上级目录段。'
  },
  'auto.lib.terminal.shortcut.capture.notification.0ab0cd001a': {
    zh: 'size-4 text-muted-foreground'
  },
  'auto.lib.terminal.shortcut.capture.notification.141ad6c004': { zh: '已处理终端快捷键' },
  'auto.lib.terminal.shortcut.capture.notification.b0536028c9': { zh: '打开快捷键设置' },
  'auto.lib.workspace.create.error.format.37cf0bc991': {
    zh: 'Orca 无法为此工作区解析可用的基准引用。'
  },
  'auto.web.WebConnect.3affe7de3a': { zh: '粘贴此浏览器可访问的 Orca 服务器配对 URL。' },
  'auto.web.WebConnect.mobileScopeRejected': {
    zh: '此二维码仅授予受限的移动端访问权限。若要使用完整 Web 应用，请前往“设置 → 运行环境 → 分享此 Orca 服务器 → 新建链接”，打开浏览器访问链接。'
  },
  'auto.web.web.preload.api.0a69fcd8bc': {
    zh: 'platforms 必须是包含 darwin、linux 或 win32 字段的对象。'
  },
  'auto.web.web.preload.api.10898045f3': {
    zh: '已忽略“{{value0}}”的快捷键：请使用字符串数组。'
  },
  'auto.web.web.preload.api.31bfe8ae1a': { zh: 'Web 客户端中不可用。' },
  'auto.web.web.preload.api.36761d9604': { zh: '已忽略未知的快捷键操作“{{value0}}”。' },
  'auto.web.web.preload.api.8dfcb7a351': { zh: 'Web 客户端不支持区域截图。' },
  'auto.web.web.preload.api.9fc90740b6': { zh: 'Web 客户端不支持生成提交信息。' },
  'auto.web.web.preload.api.b8a1618172': { zh: 'Web 客户端不支持生成 PR 详细信息。' },
  'auto.web.web.preload.api.e57c82d276': { zh: 'Web 客户端不支持检测提交信息模型。' },
  'auto.web.web.preload.api.fb290366b2': { zh: 'Web 端不可用。' },
  'auto.web.webPreloadApi.aiVaultUnavailableForHost': {
    zh: '此执行主机不支持智能体会话历史。'
  },
  'components.native-chat.composer.pastedImageLabel': { zh: '已粘贴的图片' },
  'components.native-chat.composer.worktreeNotReady': { zh: '工作树尚未就绪，请稍后重试。' },
  'components.native-chat.state.error.subtitle': {
    zh: '无法读取对话记录。请切回终端继续工作。'
  },
  'components.native-chat.state.loading.subtitle': { zh: '正在读取智能体对话记录。' },
  'components.native-chat.state.notAgent.title': { zh: '此处没有对话' }
}
