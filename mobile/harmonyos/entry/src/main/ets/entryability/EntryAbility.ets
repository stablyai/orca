import { AbilityConstant, UIAbility, Want, Configuration } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, router } from '@kit.ArkUI';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { loadAppearance, setSystemAppearance } from '../settings/Appearance';

export default class EntryAbility extends UIAbility {
  private windowReady: boolean = false;
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('pendingLaunchUri', want.uri ?? '');
    hilog.info(0x0000, 'OrcaEntry', 'application created');
    setSystemAppearance(this.context.config.colorMode ?? 0);
    loadAppearance(this.context).catch(() => {});
  }
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('pendingLaunchUri', want.uri ?? ''); this.openLaunchRoute();
  }
  private openLaunchRoute(): void {
    if (!this.windowReady) { return; }
    let uri = AppStorage.get<string>('pendingLaunchUri') ?? ''; AppStorage.setOrCreate('pendingLaunchUri', '');
    let route = parseLaunchRoute(uri);
    if (route) {
      router.pushUrl({ url: route.page, params: route.params }).catch(() => {
        hilog.error(0x0000, 'OrcaEntry', 'Could not open app route');
      });
    }
  }
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Home', (err) => {
      if (err.code) { hilog.error(0x0000, 'OrcaEntry', 'loadContent failed'); return; }
      this.windowReady = true;
    });
  }
  onConfigurationUpdate(config: Configuration): void { if (config.colorMode !== undefined) { setSystemAppearance(config.colorMode); } }
  onWindowStageDestroy(): void { this.windowReady = false; }
  onBackground(): void { this.context.eventHub.emit('orcaBackground'); }
}
