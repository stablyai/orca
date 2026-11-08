import { AbilityConstant, UIAbility, Want, Configuration, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, router } from '@kit.ArkUI';
import { loadUiLanguage, applyUiLanguage, setUiLocaleListener } from '../settings/NativeUi';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { loadAppearance, setSystemAppearance, setAppearanceListener } from '../settings/Appearance';

export default class EntryAbility extends UIAbility {
  private windowReady: boolean = false;
  private mainWindow: window.Window | null = null;
  private appliedColorMode: number = -99;
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
    AppStorage.setOrCreate('pendingLaunchUri', want.uri ?? ''); this.openLaunchRoute();
  }
  private openLaunchRoute(): void {
    if (!this.windowReady) { return; }
    let uri = AppStorage.get<string>('pendingLaunchUri') ?? ''; AppStorage.setOrCreate('pendingLaunchUri', '');
    let route = parseLaunchRoute(uri);
    if (route) {
      AppStorage.setOrCreate('explicitLaunchNavigation', true);
      router.pushUrl({ url: route.page, params: route.params }).catch(() => {
        hilog.error(0x0000, 'OrcaEntry', 'Could not open app route');
      });
    }
  }
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((mainWindow: window.Window): void => {
      this.mainWindow = mainWindow;
      setAppearanceListener((): void => { this.styleSystemBars(); this.context.eventHub.emit('orcaAppearanceChanged'); }); this.styleSystemBars();
    }).catch(() => {});
    windowStage.loadContent('pages/Home', (err) => {
      if (err.code) { hilog.error(0x0000, 'OrcaEntry', 'loadContent failed'); return; }
      try {
        windowStage.getMainWindowSync().getUIContext().getFont().registerFont({
          familyName: 'Geist', familySrc: $rawfile('fonts/Geist-Variable.ttf')
        });
      } catch (e) { hilog.warn(0x0000, 'OrcaEntry', 'Custom font could not be registered'); }
      this.windowReady = true;
    });
  }
  onConfigurationUpdate(config: Configuration): void { applyUiLanguage(); if (config.colorMode !== undefined) { setSystemAppearance(config.colorMode); } }
  onWindowStageDestroy(): void { this.windowReady = false; this.mainWindow = null; setAppearanceListener(null); setUiLocaleListener(null); }
  onForeground(): void { this.context.eventHub.emit('orcaForeground'); this.styleSystemBars(); }
  onBackground(): void { this.context.eventHub.emit('orcaBackground'); }
}
