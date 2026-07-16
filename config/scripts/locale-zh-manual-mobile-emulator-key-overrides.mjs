// Human-reviewed Simplified Chinese for mobile emulator availability and status surfaces.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_MOBILE_EMULATOR_KEY_OVERRIDES = {
  // Additional key-specific corrections found during full-catalog human review.
  'auto.lib.ensure.simulator.tab.372d21d428': { zh: '移动端模拟器' },

  'auto.components.emulator.pane.mobile.emulator.hidden.toast.c46c979c1d': {
    zh: '如需重新启用移动端模拟器，请前往'
  },

  'auto.components.emulator.pane.emulator.unavailable.pane.f630b9ca9f': {
    zh: '移动端模拟器需要安装 Xcode 和 iOS Simulator 运行时的 Mac。在 Linux 或 Windows 上，请使用实体设备或远程 Mac 构建主机。'
  },

  'auto.components.emulator.pane.emulator.unavailable.pane.b2c268a0b9': {
    zh: '移动端模拟器仅支持 macOS'
  },

  'auto.components.emulator.pane.use.emulator.frame.stream.f1c0179002': {
    zh: '视频流未输出画面。'
  }
}
