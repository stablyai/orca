import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';

@Component
export struct DesktopActions {
  @Prop name: string = '';
  @Prop subtitle: string = '';
  @Prop live: boolean = false;
  @Prop reconnect: boolean = false;
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeText') ink: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  onChoose: (action: string) => void = (_action: string): void => {};

  @Builder
  private row(action: string, label: string, icon: Resource, destructive: boolean = false) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Image(icon).supportSvg2(true).width(16).height(16)
          .colorFilter(lucideColorFilter(destructive ? this.dangerColor() : this.secondary))
        Text(uiText(label, this.locale)).fontFamily('Geist').fontSize(15)
          .fontColor(destructive ? this.dangerColor() : this.ink).layoutWeight(1)
      }.width('100%').padding({ left: 14, right: 14 })
    }.width('100%').height(46).backgroundColor(Color.Transparent)
      .accessibilityText(uiText(label, this.locale)).onClick((): void => this.onChoose(action))
  }

  @Builder
  private divider() {
    Divider().strokeWidth(0.5).color(this.borderTint).margin({ left: 42 })
  }

  private dangerColor(): string { return this.scheme === 'light' ? '#b91c1c' : '#ff6568'; }

  build() {
    Column({ space: 12 }) {
      Column({ space: 4 }) {
        Text(this.name).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.ink)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.subtitle).fontFamily('Geist').fontSize(13).fontColor(this.secondary).maxLines(2)
      }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 4, right: 4 })
      Column() {
        this.row('connect', this.reconnect ? '重新连接' : '连接', $r('app.media.lucide_refresh_cw'))
        if (this.live) {
          this.divider()
          this.row('disconnect', '断开连接', $r('app.media.lucide_power_off'))
        }
        this.divider()
        this.row('diagnostics', '网络诊断', $r('app.media.lucide_activity'))
        this.divider()
        this.row('edit', '编辑桌面', $r('app.media.lucide_pen_line'))
        this.divider()
        this.row('remove', '移除', $r('app.media.lucide_trash_2'), true)
      }.width('100%').borderRadius(16).clip(true).backgroundColor(this.surface)
        .border({ width: 0.5, color: this.borderTint, radius: 16 })
    }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 20 })
  }
}
