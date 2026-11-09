import { router } from '@kit.ArkUI';
import { readShellRoute, ShellRoute } from '../navigation/ShellRoute';
import { ShellSurface, ShellSurfaceBack } from '../webshell/ShellSurface';

@Entry
@Component
struct ShellScreen {
  @State visible: boolean = true;
  private route: ShellRoute = readShellRoute({});
  private back: ShellSurfaceBack = new ShellSurfaceBack();

  aboutToAppear(): void {
    this.route = readShellRoute((router.getParams() ?? {}) as Record<string, string>);
  }

  onPageShow(): void { this.visible = true; }
  onPageHide(): void { this.visible = false; }
  onBackPress(): boolean { return this.back.handle(); }

  build() {
    Stack() {
      ShellSurface({ request: this.route, visible: this.visible, back: this.back })
    }.width('100%').height('100%')
  }
}
