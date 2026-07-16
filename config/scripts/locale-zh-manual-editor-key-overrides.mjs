// Human-reviewed Simplified Chinese for editors, diffs, notebooks, and rich Markdown.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_EDITOR_KEY_OVERRIDES = {
  // Editors, diffs, notebooks, and rich Markdown.
  'auto.components.editor.CheckRunDetailsPanel.066fedd446': { zh: '失败的作业' },
  'auto.components.editor.CheckRunDetailsPanel.49731703ea': { zh: '作业' },
  'auto.components.editor.CheckRunDetailsPanel.fd46a70f1a': { zh: '已启动' },
  'auto.components.editor.CheckRunJobs.3e6c9a2b71': { zh: '待处理' },
  'auto.components.editor.CombinedDiffFileTree.cd0e0ed79e': { zh: '筛选差异文件' },
  'auto.components.editor.CombinedDiffViewer.948a5fd6c8': { zh: '清除笔记' },
  'auto.components.editor.CombinedDiffViewer.982d14bfa5': { zh: '打开所有更改' },
  'auto.components.editor.CombinedDiffViewer.e3b9a6ce02': { zh: '更多' },
  'auto.components.editor.CombinedDiffViewer.eb5f40e49c': {
    zh: '此差异视图会排除未解决的冲突，因为常规双向差异流程无法安全处理冲突。'
  },
  'auto.components.editor.CombinedDiffViewer.f786fd54e1': { zh: '行内' },
  'auto.components.editor.EditorContent.9640d1d3db': {
    zh: '正在预览差异中的修改后版本。切换到源码模式可查看具体更改。'
  },
  'auto.components.editor.EditorPanelHeader.94756f08ba': { zh: '切换到行内差异' },
  'auto.components.editor.EditorPanelHeader.c98ce191da': { zh: '此差异没有可打开的修改后文件' },
  'auto.components.editor.EditorPanelHeader.fb8331694e': { zh: '在侧边打开预览' },
  'auto.components.editor.EditorPanelMarkdownActionsMenu.10c39d58c1': { zh: '隐藏前置元数据' },
  'auto.components.editor.EditorPanelMarkdownActionsMenu.8c8b7f5ff5': { zh: '显示前置元数据' },
  'auto.components.editor.EditorViewToggle.e408aa9cd5': { zh: '表格' },
  'auto.components.editor.IpynbViewer.07e7d96612': { zh: '单元格' },
  'auto.components.editor.IpynbViewer.10ed04a685': {
    zh: '笔记本单元格会从笔记本所在文件夹在本机执行 Python。仅运行来自可信文件的单元格。'
  },
  'auto.components.editor.IpynbViewer.329764e9fc': { zh: '测试版' },
  'auto.components.editor.IpynbViewer.8c3b21369a': { zh: 'nbformat' },
  'auto.components.editor.MarkdownPreview.322afab6ff': { zh: '评审笔记' },
  'auto.components.editor.MarkdownPreview.94b520a96a': { zh: '已复制笔记' },
  'auto.components.editor.MarkdownPreview.bb629de58a': { zh: '复制笔记给智能体' },
  'auto.components.editor.MarkdownPreview.d737791433': { zh: '为 AI 添加笔记' },
  'auto.components.editor.MarkdownPreview.f961e94057': { zh: '复制笔记给智能体' },
  'auto.components.editor.MonacoEditor.68cb83f4a7': { zh: '在所选文本上添加笔记' },
  'auto.components.editor.NotesSendMenu.44dc5e60a6': { zh: '发送笔记' },
  'auto.components.editor.ReviewNotesSendMenuContent.03378aea75': { zh: '将笔记发送到' },
  'auto.components.editor.ReviewNotesSendMenuContent.50f7e753ea': {
    zh: '正在将笔记发送给当前智能体…'
  },
  'auto.components.editor.ReviewNotesSendMenuContent.bb9c69a0c9': {
    zh: '笔记已发送给当前智能体。'
  },
  'auto.components.editor.ReviewNotesSendMenuContent.f5096c6e4e': {
    zh: '无法将笔记发送给当前智能体。'
  },
  'auto.components.editor.RichMarkdownReviewNoteLayer.117432e2c6': { zh: '已复制笔记' },
  'auto.components.editor.RichMarkdownReviewNoteLayer.3ababd949d': { zh: '评审笔记' },
  'auto.components.editor.RichMarkdownReviewNoteLayer.9cde7ad994': { zh: '复制笔记给智能体' },
  'auto.components.editor.RichMarkdownReviewRailActions.636394af72': { zh: '复制笔记给智能体' },
  'auto.components.editor.RichMarkdownReviewRailActions.a807596997': { zh: '已复制笔记' },
  'auto.components.editor.RichMarkdownSlashMenu.e2e12b0e98': { zh: '组件' },
  'auto.components.editor.RichMarkdownToolbar.6d52624712': { zh: '链接' },
  'auto.components.editor.rich.markdown.slash.commands.0ed9a7b38c': {
    zh: '插入 Mermaid 围栏代码块。'
  },
  'auto.components.editor.rich.markdown.slash.commands.19ea597868': { zh: '表格' },
  'auto.components.editor.rich.markdown.slash.commands.2bf5544faf': { zh: '行内公式' },
  'auto.components.editor.rich.markdown.slash.commands.2f9d6b4e10': { zh: '设为三级标题' },
  'auto.components.editor.rich.markdown.slash.commands.41482b15ce': { zh: '设为一级标题' },
  'auto.components.editor.rich.markdown.slash.commands.565907cf7a': {
    zh: '插入行内 LaTeX 公式。'
  },
  'auto.components.editor.rich.markdown.slash.commands.5e0b9c2a71': { zh: '设为四级标题' },
  'auto.components.editor.rich.markdown.slash.commands.6993a38ad1': { zh: '块级公式' },
  'auto.components.editor.rich.markdown.slash.commands.7a2c1f9b04': { zh: '设为二级标题' },
  'auto.components.editor.rich.markdown.slash.commands.89e327e054': { zh: '插入围栏代码块。' },
  'auto.components.editor.rich.markdown.slash.commands.9a7fe896dc': { zh: '插入普通段落。' },
  'auto.components.editor.rich.markdown.slash.commands.ae7d0f3f37': {
    zh: '插入块级 LaTeX 公式。'
  },
  'auto.components.editor.rich.markdown.slash.commands.ae8377cf6b': { zh: '分隔线' },
  'auto.components.editor.rich.markdown.slash.commands.e516d3f6e3': { zh: 'Mermaid 图表' },
  'auto.components.editor.rich.markdown.slash.commands.f82c78a2ee': { zh: '设为正文' },
  'auto.components.diff.comments.DiffCommentCard.cce596969e': { zh: '删除笔记' },
  'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50': { zh: '此笔记' },

  // Additional key-specific corrections found during full-catalog human review.
  'auto.components.editor.IpynbViewer.fd8ac707bc': { zh: '上移单元格' },

  'auto.components.editor.UntitledFileRenameDialog.b6ed807cc6': { zh: '名称' },

  'auto.components.editor.EditorViewToggle.4d6ccb7ba6': { zh: '源代码' },

  'auto.components.editor.EditorContent.e4b074749d': { zh: '文档元数据' },

  'auto.components.editor.MarkdownPreview.2b2b31382c': { zh: '文档元数据' },

  'auto.components.editor.CheckRunDetailsPanel.5a1c8e3d67': { zh: '中立' },

  'auto.components.editor.PdfFind.db56fcd6d2': { zh: '{{value0}} / {{value1}}' },

  'auto.components.editor.ImageDiffViewer.a651be62b0': { zh: '修改后' },

  'auto.components.editor.ImageDiffViewer.57aac3979a': { zh: '原图' },

  'auto.components.editor.ExternalFileChangeBanner.7c41e90d12': {
    zh: '文件已在磁盘上被外部修改。若保存当前编辑，将覆盖磁盘中的较新内容。'
  },

  'auto.components.editor.CombinedDiffViewer.35cc27aeb2': { zh: '在源代码管理中' },

  'auto.components.editor.ConflictComponents.28e7db4a90': { zh: '源代码管理' },

  'auto.components.editor.CheckRunDetailsPanel.cdbfda4dec': { zh: '注解' },

  'auto.components.editor.CombinedDiffViewer.39f8007549': { zh: '查看冲突' },

  'auto.components.editor.PdfViewer.3e98d500d2': { zh: 'PDF 预览' }
}
