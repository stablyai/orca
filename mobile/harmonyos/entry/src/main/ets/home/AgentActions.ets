import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { AgentListRow } from './AgentListModel';

@Component
export struct AgentActions {
  @Prop row: AgentListRow | null = null;
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeText') ink: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  @StorageProp('themeRaised') group: string = '#262626';
  @StorageProp('themeScheme') scheme: string = 'dark';
  onChoose: (action: string) => void = (_action: string): void => {};

  @Builder
  private action(id: string, label: string, icon: Resource, unavailable: boolean = false) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Image(icon).width(16).height(16).supportSvg2(true).colorFilter(lucideColorFilter(this.secondary))
        Column({ space: 2 }) {
          Text(uiText(label, this.locale)).fontFamily('Geist').fontSize(15).fontColor(this.ink)
          if (unavailable) {
            Text(uiText('其桌面已离线。', this.locale)).fontFamily('Geist').fontSize(12).fontColor(this.secondary)
          }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      }.width('100%').padding({ left: 14, right: 14, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 44 }).backgroundColor(Color.Transparent)
      .accessibilityText(unavailable ? `${uiText(label, this.locale)}. ${uiText('其桌面已离线。', this.locale)}` : uiText(label, this.locale))
      .enabled(!unavailable).opacity(unavailable ? 0.5 : 1).onClick((): void => this.onChoose(id))
  }

  @Builder
  private divider() {
    Divider().strokeWidth(0.5).color(this.borderTint).margin({ left: 42 })
  }

  build() {
    if (this.row) {
      Column({ space: 12 }) {
        Column({ space: 4 }) {
          Text(this.row.title).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium)
            .fontColor(this.ink).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.row.entry.workspaceName).fontFamily('Geist').fontSize(13).fontColor(this.secondary).maxLines(2)
        }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 4, right: 4 })
        Column() {
          this.action('open', '打开', $r('app.media.lucide_arrow_up_right'), this.row.offline)
          this.divider()
          this.action('workspace', '前往工作区', $r('app.media.lucide_folder'), this.row.offline)
          if (this.row.unread !== undefined) {
            this.divider()
            this.action('read', this.row.unread ? '标为已读' : '标为未读',
              this.row.unread ? $r('app.media.lucide_eye') : $r('app.media.lucide_eye_off'))
          }
          this.divider()
          this.action('copy', '复制标题', $r('app.media.lucide_copy'))
          if (this.row.clearable) {
            this.divider()
            this.action('clear', '清除列表项', $r('app.media.lucide_x'))
          }
        }.width('100%').borderRadius(16).clip(true).backgroundColor(this.scheme === 'light' ? '#ffffff' : this.group)
      }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 20 })
    }
  }
}
