import { uiText } from '../settings/NativeUi';
import { router } from '@kit.ArkUI';
import { readPagePreferencesSync, setString, KEY_DEFAULT_SESSION_VIEW } from '../settings/SettingsStore';

@Entry
@Component
struct NativeChatSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @State value: string = 'terminal';
  @State error: string = '';
  @State saving: boolean = false;

  aboutToAppear(): void {
    try { this.value = readPagePreferencesSync(getContext(this)).get(KEY_DEFAULT_SESSION_VIEW) ?? 'terminal'; }
    catch (e) { this.error = '无法读取设置'; }
  }

  private async select(value: string): Promise<void> {
    if (this.saving) { return; }
    this.saving = true; this.error = '';
    try { await setString(getContext(this), KEY_DEFAULT_SESSION_VIEW, value); this.value = value; }
    catch (e) { this.error = '无法保存设置，请重试'; }
    finally { this.saving = false; }
  }

  build() {
    Column() {
      Row() {
        Button('‹').fontFamily('Geist').fontSize(24).fontColor(this.themeText).backgroundColor(Color.Transparent).width(44).height(44).accessibilityText('返回').onClick((): void => { router.back(); })
        Text(uiText('聊天界面', this.uiLocale)).fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Medium).fontColor(this.themeText).layoutWeight(1)
      }.width('100%').padding({ top: 8, right: 16 })
      Column() {
        Row() {
          Text(uiText('终端', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
          if (this.value === 'terminal') { Text('✓').fontColor(this.themeAccent) }
        }.width('100%').height(48).padding({ left: 16, right: 16 }).enabled(!this.saving)
        .onClick((): void => { this.select('terminal'); })
        Row() {
          Text(uiText('聊天界面', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).layoutWeight(1)
          if (this.value === 'chat') { Text('✓').fontColor(this.themeAccent) }
        }.width('100%').height(48).padding({ left: 16, right: 16 }).enabled(!this.saving)
        .onClick((): void => { this.select('chat'); })
      }.width('100%').backgroundColor(this.themeSurface).borderRadius(12).margin({ top: 24 })
      Text(uiText('为支持聊天界面的 Agent 选择默认会话视图；仍可在单个会话中切换。', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).width('100%').padding({ top: 8 })
      if (this.error.length > 0) { Text(this.error).fontFamily('Geist').fontSize(13).fontColor(this.themeText).width('100%').padding({ top: 16 }) }
    }.width('100%').height('100%').padding({ left: 16, right: 16 }).backgroundColor(this.themeBg)
  }
}
