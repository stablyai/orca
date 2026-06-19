// Chinese phrase fixes from high-visibility UI audit round 5.
export const ZH_PHRASE_FIXES_ROUND5 = [
  { pattern: /Orca集成开发环境/g, replacement: 'Orca IDE', whenEnIncludes: 'Orca IDE' },
  { pattern: /Orca第一/g, replacement: 'Orca 优先', whenEnIncludes: 'Orca first' },
  { pattern: /Orca移动/g, replacement: 'Orca Mobile', whenEnIncludes: 'Orca Mobile' },
  { pattern: /Orca归属/g, replacement: 'Orca 归因', whenEnIncludes: 'Orca Attribution' },
  { pattern: /Orca标志/g, replacement: 'Orca 标志', whenEnIncludes: 'Orca logo' },
  { pattern: /喜欢Orca/g, replacement: '喜欢 Orca', whenEnIncludes: 'Enjoying Orca' },
  { pattern: /认识Orca/g, replacement: '了解 Orca', whenEnIncludes: 'Get to know Orca' },
  { pattern: /支持Orca/g, replacement: '支持 Orca', whenEnIncludes: 'Support Orca' },
  { pattern: /展开Orca/g, replacement: '展开 Orca', whenEnIncludes: 'Expand Orca' },
  { pattern: /来自Orca/g, replacement: '来自 Orca', whenEnIncludes: 'from Orca' },
  {
    pattern: /正在重新启动Orca/g,
    replacement: '正在重启 Orca',
    whenEnIncludes: 'Restarting Orca'
  },
  { pattern: /Orca([\u4e00-\u9fff])/g, replacement: 'Orca $1', whenEnIncludes: 'Orca' },
  { pattern: /Linear([\u4e00-\u9fff])/g, replacement: 'Linear $1', whenEnIncludes: 'Linear' },
  { pattern: /Codex([\u4e00-\u9fff])/g, replacement: 'Codex $1', whenEnIncludes: 'Codex' },
  { pattern: /Claude([\u4e00-\u9fff])/g, replacement: 'Claude $1', whenEnIncludes: 'Claude' },
  { pattern: /Claude代码/g, replacement: 'Claude Code', whenEnIncludes: 'Claude Code' },
  { pattern: /GitHub 和Linear/g, replacement: 'GitHub 和 Linear', whenEnIncludes: 'Linear tasks' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'hosted-review' },
  { pattern: /托管审阅/g, replacement: '托管评审', whenEnIncludes: 'Hosted-review' },
  { pattern: /审阅笔记/g, replacement: '评审笔记', whenEnIncludes: 'review note' },
  { pattern: /审阅任务/g, replacement: '评审任务', whenEnIncludes: 'review task' },
  { pattern: /待审阅/g, replacement: '待评审', whenEnIncludes: 'need review' },
  { pattern: /重新审核/g, replacement: '重新评审', whenEnIncludes: 'Re-review' },
  { pattern: /依赖项审核/g, replacement: '依赖项审计', whenEnIncludes: 'dependency audit' },
  { pattern: /Git AI 作者/g, replacement: 'Git AI Author', whenEnIncludes: 'Git AI Author' },
  { pattern: /基本引用/g, replacement: '基础引用', whenEnIncludes: 'base ref' },
  { pattern: /重新开放PR/g, replacement: '重新打开 PR', whenEnIncludes: 'Reopen PR' },
  { pattern: /重新开放/g, replacement: '重新打开', whenEnIncludes: 'reopen' },
  { pattern: /受限制的钥匙/g, replacement: '受限制的密钥', whenEnIncludes: 'restricted keys' },
  { pattern: /更换钥匙/g, replacement: '更换密钥', whenEnIncludes: 'Replace key' },
  {
    pattern: /根据所看到的内容采取行动/g,
    replacement: '根据所看到的内容执行操作',
    whenEnIncludes: 'act on what they see'
  },
  {
    pattern: /建议下一步行动/g,
    replacement: '建议下一步操作',
    whenEnIncludes: 'suggest next actions'
  },
  {
    pattern: /可操作的问题/g,
    replacement: '需处理的问题',
    whenEnIncludes: 'actionable issues'
  },
  {
    pattern: /显示 Orca 移动按钮/g,
    replacement: '显示 Orca Mobile 按钮',
    whenEnIncludes: 'Show Orca Mobile Button'
  }
]
