export interface SettingsMenuItem { label: string; subtitle: string; icon: Resource; target: string; tag: string; }
export const SETTINGS_MENU_ITEMS: SettingsMenuItem[] = [
  { label: '外观', subtitle: '主题、界面显示', icon: $r('app.media.lucide_sun_moon'), target: 'pages/AppearanceSettings', tag: 'theme' },
  { label: '终端', subtitle: '字号、桌面恢复尺寸、快捷键', icon: $r('app.media.lucide_terminal'), target: 'pages/TerminalSettings', tag: '' },
  { label: '聊天界面', subtitle: 'Agent 会话默认视图', icon: $r('app.media.lucide_message_square'), target: 'pages/NativeChatSettings', tag: '' },
  { label: '浏览器', subtitle: '终端链接打开位置', icon: $r('app.media.lucide_globe'), target: 'pages/BrowserSettings', tag: '' },
  { label: '语音', subtitle: '听写引擎与本机识别', icon: $r('app.media.lucide_mic'), target: 'pages/VoiceSettings', tag: 'dictation' },
  { label: '通知', subtitle: '系统权限、本地提醒、免打扰', icon: $r('app.media.lucide_bell'), target: 'pages/NotificationSettings', tag: '' },
  { label: '故障排查', subtitle: '桌面连接与事件日志', icon: $r('app.media.lucide_wrench'), target: 'pages/Troubleshoot', tag: '' },
  { label: '关于', subtitle: '版本与开源许可', icon: $r('app.media.lucide_info'), target: 'pages/About', tag: '' }
];
export const SETTINGS_LINK_ITEMS: SettingsMenuItem[] = [
  { label: '隐私政策', subtitle: '', icon: $r('app.media.lucide_shield'), target: 'https://www.onorca.dev/privacy', tag: '' },
  { label: '支持', subtitle: '', icon: $r('app.media.lucide_life_buoy'), target: 'https://github.com/stablyai/orca/issues', tag: '' }
];
