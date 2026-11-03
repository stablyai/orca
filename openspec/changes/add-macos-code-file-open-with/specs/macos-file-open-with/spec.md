# Spec Delta

## Purpose

让 macOS 用户从 Finder 为代码、配置和文本文件选择 Orca，并在不要求添加项目的情况下直接编辑原文件。系统请求在冷启动、运行中和多文件场景下进入本机独立文件区，保留默认应用选择及原有文件访问保护。

## ADDED Requirements

### Requirement: 代码配置与文本的可选打开应用

macOS 安装包 SHALL 为已有语言识别支持的代码后缀、常见配置后缀和纯文本后缀声明可选编辑器，并保留已有文档关联。声明 MUST 使用 Alternate 级别，不主动设置系统默认应用，不使用通用二进制文件或星号关联。

#### Scenario: 常见代码文件可选择 Orca

- **WHEN** 用户查看 package.json、source.ts、script.py、config.yaml 或 notes.txt 的系统候选打开应用
- **THEN** 注册后的 macOS 测试包出现在候选列表，原默认应用保持不变

### Requirement: 显式文件请求进入本机独立文件区

系统 SHALL 将 macOS 用户显式选择的现有本地普通文件打开到独立文件区，沿用语言识别、文件编辑和原路径保存能力。用户通过“其他…”指定的无扩展名或未知后缀文本 MUST 同样能够打开。活动项目为远程或普通文件夹工作区时，该文件仍属于本机独立文件区。

#### Scenario: 无扩展名与未知后缀文本

- **WHEN** 用户通过系统选择 Orca 打开 Dockerfile、.env 或自定义后缀的文本文件
- **THEN** 文件显示在本机独立文件区，保存写回原路径，内容不被复制到工作区目录

#### Scenario: 目录或缺失文件

- **WHEN** 系统请求的路径是目录或文件已不存在
- **THEN** Orca 不为该路径创建编辑标签，并继续处理同批次的有效文件

### Requirement: 启动参数安全与文件交付可靠性

系统 SHALL 区分完整程序启动参数和用户文件路径，MUST NOT 将可执行文件、开发入口或开关本身作为用户文档。系统 SHALL 保留 file URL 解码、路径去重、32 项待交付队列和原有二进制、大小限制处理。

#### Scenario: 普通启动不打开自身入口

- **WHEN** Orca 以安装包或默认 Electron 加载开发入口的方式启动，启动参数没有用户文件
- **THEN** 不产生系统文件编辑标签

#### Scenario: 冷启动运行中及重复请求

- **WHEN** macOS 在启动前后交付包含空格、中文或 file URL 的有效文件，并再次交付同一文件
- **THEN** 有效文件得到展示，同一路径仅有一个编辑标签，首个文件不会被误当作程序入口丢弃

### Requirement: 桌面平台兼容

Windows 和 Linux SHALL 保留现有 Markdown、CSV、TSV 文件接收与安装声明，不因 macOS 扩展而自动接收新增代码类型。

#### Scenario: 其他平台的文件接收范围

- **WHEN** Windows 或 Linux 收到包含 Markdown、CSV、TSV、JS 和未知后缀的系统文件参数
- **THEN** 仅既有支持的文档类型被接收，路径解码与去重保持可用
