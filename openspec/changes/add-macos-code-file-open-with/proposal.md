# Proposal

## Why

Orca 已能接收系统文件打开请求，但安装包和主进程目前只接收 Markdown、CSV、TSV。用户无法像选择 VS Code 一样，在 macOS Finder 的“打开方式”中选择 Orca 编辑 package.json、代码和配置文件。

## What Changes

- macOS 声明已有编辑器支持的代码后缀及常见配置、纯文本后缀，注册为可选编辑器，默认应用仍由用户决定。
- macOS 接收用户显式请求的本地文件，包括通过“其他…”选择的无扩展名及未知后缀文件。
- 区分完整启动参数和纯文件路径，防止将 Orca 自身入口当作文档。
- 复用独立浮动工作区、语言识别、去重与原路径编辑保存；Windows、Linux 保留既有接收范围。

## Capabilities

### New Capabilities

- `macos-file-open-with`: Finder 候选应用声明、系统文件打开请求及独立文件编辑。

### Modified Capabilities

无。当前仓库无既有 OpenSpec 主规格。

## Impact

影响 macOS 打包声明、共享语言后缀数据、主进程系统文件接收及独立文件操作的目录变更校验。沿用现有 FileDocument 和 IPC，不引入依赖。验证覆盖参数解析、文件解析、隐藏 Electron 的打开与保存，以及实际打包后的系统文件关联。
