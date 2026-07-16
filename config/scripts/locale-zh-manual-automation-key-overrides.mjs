// Human-reviewed Simplified Chinese for automation scheduling and run history.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_AUTOMATION_KEY_OVERRIDES = {
  // Automations.
  'auto.components.automations.AutomationCustomCronPanel.3e3b2c369f': { zh: 'Cron 表达式' },
  'auto.components.automations.AutomationCustomCronPanel.cadb7b0bc9': { zh: '无效' },
  'auto.components.automations.AutomationDetail.401f40ae79': { zh: '预计费用' },
  'auto.components.automations.AutomationDetail.620b22145e': { zh: '补跑宽限期' },
  'auto.components.automations.AutomationDetail.a1d52c2189': { zh: '用量统计覆盖范围' },
  'auto.components.automations.AutomationDetail.de0fedac06': { zh: 'new_per_run' },
  'auto.components.automations.AutomationDetail.eaa02014f8': { zh: '已启用' },
  'auto.components.automations.AutomationEditorDialog.a4ac8fcc62': { zh: '/goal' },
  'auto.components.automations.AutomationEditorDialog.ff5db28639': { zh: '现有' },
  'auto.components.automations.AutomationEditorDialogHeader.0a75e5e2fa': {
    zh: '创建 Hermes 自动化'
  },
  'auto.components.automations.AutomationMissedRunGraceField.3d70c185c8': {
    zh: '如果 Orca 或执行主机在计划时间不可用，只要在此宽限期内恢复可用，Orca 就会补跑一次。更早错过的运行会被跳过。'
  },
  'auto.components.automations.AutomationMissedRunGraceField.3df53d554a': {
    zh: '补跑宽限期说明'
  },
  'auto.components.automations.AutomationMissedRunGraceField.529dc6c0b7': { zh: '无宽限期' },
  'auto.components.automations.AutomationMissedRunGraceField.fc089e5fde': { zh: '补跑宽限期' },
  'auto.components.automations.AutomationPrecheckFields.bb2dfb3629': { zh: '超时' },
  'auto.components.automations.AutomationRunHistory.402651bfb6': { zh: '暂无运行记录。' },
  'auto.components.automations.AutomationRunHistory.53fc5f07ab': { zh: '运行记录' },
  'auto.components.automations.AutomationRunHistory.86a248187e': { zh: '费用' },
  'auto.components.automations.AutomationRunPageFrame.33741dd973': { zh: '返回运行记录' },
  'auto.components.automations.AutomationSchedulePicker.233b8c94b6': { zh: '频率' },
  'auto.components.automations.AutomationSchedulePicker.c3e39e17cf': { zh: '自定义' },
  'auto.components.automations.AutomationSessionField.4bdce31f37': { zh: '会话复用说明' },
  'auto.components.automations.AutomationSessionField.c90888ee94': { zh: '新会话' },
  'auto.components.automations.AutomationSessionField.f3c76dce51': { zh: '复用' },
  'auto.components.automations.AutomationsPage.0ae52dd760': { zh: 'hermes' },
  'auto.components.automations.AutomationsPage.0e110a3469': { zh: '运行记录' },
  'auto.components.automations.AutomationsPage.2430fecf53': {
    zh: '保存前请选择运行位置并输入提示词。'
  },
  'auto.components.automations.AutomationsPage.25060635c6': { zh: '新增' },
  'auto.components.automations.AutomationsPage.36f71740a7': { zh: '所选工作区' },
  'auto.components.automations.AutomationsPage.37288942f0': { zh: '已恢复外部自动化。' },
  'auto.components.automations.AutomationsPage.4d7878402c': { zh: '外部自动化已加入队列。' },
  'auto.components.automations.AutomationsPage.77b81bc4ac': { zh: '已创建 Hermes 自动化。' },
  'auto.components.automations.AutomationsPage.7934ee0d81': { zh: '连接 SSH' },
  'auto.components.automations.AutomationsPage.9f2855677c': { zh: 'SSH 已连接。' },
  'auto.components.automations.AutomationsPage.a1bdb57008': { zh: '自动化运行已加入队列。' },
  'auto.components.automations.AutomationsPage.aecdc3681f': { zh: '可管理' },
  'auto.components.automations.AutomationsPage.bb1b2cd31e': { zh: '概览' },
  'auto.components.automations.AutomationsPage.c3a28c9793': { zh: '选择自动化以查看运行记录。' },
  'auto.components.automations.AutomationsPage.dd0bc7a1ba': { zh: 'new_per_run' },
  'auto.components.automations.ExternalAutomationManagers.0a2d4359a8': { zh: '可管理' },
  'auto.components.automations.ExternalAutomationManagers.20fd7a3a15': { zh: '下次' },
  'auto.components.automations.ExternalAutomationManagers.330b3c32e8': { zh: '可用' },
  'auto.components.automations.ExternalAutomationManagers.3d58d5b67d': { zh: '无' },
  'auto.components.automations.ExternalAutomationManagers.5820648765': { zh: '上次' },
  'auto.components.automations.ExternalAutomationManagers.844f1acb72': { zh: '已找到' },
  'auto.components.automations.ExternalAutomationManagers.b3feba84c7': { zh: '活跃' },
  'auto.components.automations.ExternalAutomationManagers.bf5f67b590': { zh: 'hermes' },
  'auto.components.automations.ExternalAutomationManagers.e02f970595': {
    zh: '未找到外部自动化管理器。'
  },
  'auto.components.automations.ExternalAutomationRunTable.0ba9c0a95c': { zh: '下一页' },
  'auto.components.automations.ExternalAutomationRunTable.2d4388a908': { zh: '运行记录' },
  'auto.components.automations.ExternalAutomationRunTable.52d468a0b8': { zh: '上一页' },
  'auto.components.automations.HermesCronOutputView.4557213074': { zh: '响应' },
  'auto.components.automations.automation.templates.6023075b27': { zh: '每日变更评审' },
  'auto.components.automations.automation.templates.8a0228bea3': { zh: '每小时检查队列' },
  'auto.components.automations.automation.templates.releasePrep.prompt': {
    zh: '准备一份发布就绪摘要。检查阻塞项、尚未合并的高风险更改、缺失的验证和文档空白，最后给出简短明确的发布或暂缓发布建议。'
  },
  'auto.components.automations.automation.templates.repoHealth.category': { zh: '仓库健康状况' },
  'auto.components.automations.external.automation.schedule.display.a8e92b815a': {
    zh: '执行计划不可用'
  },

  // Additional key-specific corrections found during full-catalog human review.
  'auto.components.automations.automation.templates.recurringReview.name': {
    zh: '每日变更评审'
  }
}
