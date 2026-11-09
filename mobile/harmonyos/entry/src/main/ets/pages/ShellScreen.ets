import { router } from '@kit.ArkUI';
import { desktopPath, isDesktopSession, readShellRoute, ShellRoute, shellRouterParams } from '../navigation/ShellRoute';
import { ShellSurface, ShellSurfaceBack } from '../webshell/ShellSurface';

@Entry
@Component
struct ShellScreen {
  @State visible: boolean = true;
  private route: ShellRoute = readShellRoute({});
  private sessionTarget: ShellRoute | null = null;
  private returnsToDesktop: boolean = false;
  private navigating: boolean = false;
  private back: ShellSurfaceBack = new ShellSurfaceBack();

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.route = readShellRoute(params);
    if (params['hostListFirst'] === '1' && isDesktopSession(this.route)) {
      this.sessionTarget = this.route;
      this.route = { hostId: this.route.hostId, pathname: desktopPath(this.route.hostId), params: {} };
    }
    this.returnsToDesktop = params['returnsToDesktop'] === '1' && isDesktopSession(this.route);
  }

  onPageShow(): void { this.visible = true; }
  onPageHide(): void { this.visible = false; }
  onBackPress(): boolean { return this.back.handle(); }

  private openPage(route: ShellRoute, replace: boolean): void {
    if (this.navigating) { return; }
    this.navigating = true;
    let params = shellRouterParams(route);
    if (isDesktopSession(route) && (this.route.pathname === desktopPath(route.hostId) || (replace && this.returnsToDesktop))) {
      params['returnsToDesktop'] = '1';
    }
    let page: router.RouterOptions = { url: 'pages/ShellScreen', params: params };
    let navigation = replace ? router.replaceUrl(page) : router.pushUrl(page);
    navigation.catch(() => {}).finally((): void => { this.navigating = false; });
  }

  build() {
    Stack() {
      ShellSurface({ request: this.route, visible: this.visible, back: this.back, sessionTarget: this.sessionTarget,
        returnsToDesktop: this.returnsToDesktop,
        onNativeSession: (route: ShellRoute): void => this.openPage(route, false),
        onNativeRoute: (route: ShellRoute, replace: boolean): void => this.openPage(route, replace) })
    }.width('100%').height('100%')
  }
}
