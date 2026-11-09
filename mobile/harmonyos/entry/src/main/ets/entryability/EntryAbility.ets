import { dropHomePrewarm, dropPrewarmForMemoryPressure } from '../webshell/HomeShellPrewarm';
import { closeIdleDesktopConnections, reviveDesktopConnections } from '../transport/DesktopConnections';
import { AbilityConstant, UIAbility, Want, Configuration, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, router } from '@kit.ArkUI';
import { loadUiLanguage, applyUiLanguage, setUiLocaleListener } from '../settings/NativeUi';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { loadAppearance, setSystemAppearance, setAppearanceListener } from '../settings/Appearance';
import { ShellWindowRegions } from '../webshell/WindowRegions';

export default class EntryAbility extends UIAbility {
  private windowReady: boolean = false;
  private launchNavigationPending: boolean = false;
  private mainWindow: window.Window | null = null;
  private windowRegions: ShellWindowRegions | null = null;
  private appliedColorMode: number = -99;
  private readonly keyboardAreaChanged = (change: window.AvoidAreaOptions): void => {
    if (change.type === window.AvoidAreaType.TYPE_KEYBOARD) { this.publishKeyboardArea(change.area); }
  };
  private publishKeyboardArea(area?: window.AvoidArea): void {
    let current = this.mainWindow;
    if (!current) { return; }
    let rect = area?.bottomRect;
    let top = rect && rect.height > 0 ? current.getUIContext().px2vp(rect.top) : -1;
    AppStorage.setOrCreate('shellKeyboardTop', Number.isFinite(top) ? top : -1);
  }
  private refreshKeyboardArea(): void {
    let current = this.mainWindow;
    if (!current || !AppStorage.get<boolean>('shellKeyboardOverlay')) { return; }
    try { this.publishKeyboardArea(current.getWindowAvoidArea(window.AvoidAreaType.TYPE_KEYBOARD)); }
    catch (e) { this.publishKeyboardArea(); }
  }
  private styleSystemBars(): void {
    if (!this.mainWindow) { return; }
    let light = AppStorage.get<string>('themeScheme') === 'light';
    let preference = AppStorage.get<string>('themeMode') ?? 'system';
    let colorMode = preference === 'system' ? ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET
      : light ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT : ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    if (this.appliedColorMode !== colorMode) {
      let previous = this.appliedColorMode; this.appliedColorMode = colorMode;
      try { this.context.getApplicationContext().setColorMode(colorMode); } catch (e) { this.appliedColorMode = previous; }
    }
    let background = AppStorage.get<string>('themeBg') ?? '#0a0a0a';
    try { this.mainWindow.setWindowBackgroundColor(background); } catch (e) {}
    this.mainWindow.setWindowSystemBarProperties({ statusBarColor: background, navigationBarColor: background,
      statusBarContentColor: AppStorage.get<string>('themeText') ?? '#fafafa',
      navigationBarContentColor: AppStorage.get<string>('themeText') ?? '#fafafa',
      isStatusBarLightIcon: !light, isNavigationBarLightIcon: !light }).catch(() => {});
  }
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('explicitLaunchNavigation', false);
    AppStorage.setOrCreate('pendingLaunchUri', want.uri ?? '');
    hilog.info(0x0000, 'OrcaEntry', 'application created');
    setSystemAppearance(this.context.config.colorMode ?? 0);
    loadAppearance(this.context).catch(() => {});
    setUiLocaleListener((): void => this.context.eventHub.emit('orcaLocaleChanged'));
    loadUiLanguage(this.context).catch(() => hilog.warn(0x0000, 'OrcaEntry', 'UI language could not be loaded'));
  }
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    if (!want.uri) { return; }
    AppStorage.setOrCreate('pendingLaunchUri', want.uri);
    this.openLaunchRoute().catch(() => {});
  }
  private async openLaunchRoute(): Promise<void> {
    if (!this.windowReady || !this.mainWindow || this.launchNavigationPending) { return; }
    let uri = AppStorage.get<string>('pendingLaunchUri') ?? ''; AppStorage.setOrCreate('pendingLaunchUri', '');
    let route = parseLaunchRoute(uri);
    if (!route) { return; }
    this.launchNavigationPending = true;
    AppStorage.setOrCreate('explicitLaunchNavigation', true);
    try {
      let navigation = this.mainWindow.getUIContext().getRouter();
      let options: router.RouterOptions = { url: route.page, params: route.params };
      if (route.page === 'pages/PairScan' && navigation.getState().name === 'PairScan') {
        await navigation.replaceUrl(options);
      } else { await navigation.pushUrl(options); }
    } catch (e) {
      hilog.error(0x0000, 'OrcaEntry', 'Could not open app route');
    } finally {
      this.launchNavigationPending = false;
    }
    await this.openLaunchRoute();
  }
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Home', (err) => {
      if (err.code) { hilog.error(0x0000, 'OrcaEntry', 'loadContent failed'); return; }
      let mainWindow = windowStage.getMainWindowSync();
      this.mainWindow = mainWindow;
      this.windowRegions = new ShellWindowRegions(mainWindow);
      this.windowRegions.start();
      setAppearanceListener((): void => { this.styleSystemBars(); this.context.eventHub.emit('orcaAppearanceChanged'); });
      this.styleSystemBars();
      try {
        let area = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_KEYBOARD);
        mainWindow.on('avoidAreaChange', this.keyboardAreaChanged);
        this.publishKeyboardArea(area);
        AppStorage.setOrCreate('shellKeyboardOverlay', true);
      } catch (e) { AppStorage.setOrCreate('shellKeyboardOverlay', false); }
      try {
        mainWindow.getUIContext().getFont().registerFont({
          familyName: 'Geist', familySrc: $rawfile('fonts/Geist-Variable.ttf')
        });
      } catch (e) { hilog.warn(0x0000, 'OrcaEntry', 'Custom font could not be registered'); }
      this.windowReady = true;
    });
  }
  onConfigurationUpdate(config: Configuration): void { applyUiLanguage(); if (config.colorMode !== undefined) { setSystemAppearance(config.colorMode); } }
  onWindowStageDestroy(): void {
    closeIdleDesktopConnections(); dropHomePrewarm(); this.windowReady = false;
    try { this.mainWindow?.off('avoidAreaChange', this.keyboardAreaChanged); } catch (e) {}
    this.mainWindow = null;
    this.windowRegions?.dispose(); this.windowRegions = null;
    AppStorage.setOrCreate('shellKeyboardOverlay', false); AppStorage.setOrCreate('shellKeyboardTop', -1);
    setAppearanceListener(null); setUiLocaleListener(null);
  }
  onForeground(): void {
    reviveDesktopConnections(); this.refreshKeyboardArea(); this.windowRegions?.refresh();
    this.context.eventHub.emit('orcaForeground'); this.styleSystemBars();
  }
  onBackground(): void {
    closeIdleDesktopConnections(); dropHomePrewarm(); this.context.eventHub.emit('orcaBackground'); this.publishKeyboardArea();
  }
  onMemoryLevel(_level: AbilityConstant.MemoryLevel): void { dropPrewarmForMemoryPressure(); }
}
