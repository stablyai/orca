import { uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { KEY_DEFAULT_SESSION_VIEW, readPagePreferencesSync, setString } from '../settings/SettingsStore';

const CHAT_KEYS = 'settings.nativeChatSettingsScreen.';

@Entry
@Component
struct NativeChatSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State chatEnabled: boolean = false;
  @State error: string = '';
  @State saving: boolean = false;

  aboutToAppear(): void {
    try {
      this.chatEnabled = readPagePreferencesSync(getContext(this)).get(KEY_DEFAULT_SESSION_VIEW) === 'chat';
    } catch (e) {
      this.error = 'loadFailed';
    }
  }

  private t(key: string): string {
    return uiText(CHAT_KEYS + key, this.uiLocale);
  }

  private async select(enabled: boolean): Promise<void> {
    if (this.saving || this.chatEnabled === enabled) { return; }
    const previous = this.chatEnabled;
    this.saving = true;
    this.error = '';
    this.chatEnabled = enabled;
    try {
      await setString(getContext(this), KEY_DEFAULT_SESSION_VIEW, enabled ? 'chat' : 'terminal');
    } catch (e) {
      this.chatEnabled = previous;
      this.error = 'saveFailed';
    } finally {
      this.saving = false;
    }
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('title') })
      Scroll() {
        Column() {
          Text(this.t('defaultViewHeading')).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium)
            .fontColor(this.themeSecondary).width('100%').padding({ left: 16, bottom: 6 })
          Row({ space: 12 }) {
            Column({ space: 2 }) {
              Text(this.t('openInChatUi')).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium)
                .fontColor(this.themeText)
              Text(this.t(this.chatEnabled ? 'on' : 'off')).fontFamily('Geist').fontSize(13)
                .fontColor(this.themeSecondary)
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.chatEnabled }).selectedColor(this.themeAccent)
              .width(51).height(31).enabled(!this.saving).accessibilityText(this.t('openInChatUi'))
              .onChange((enabled: boolean): void => { this.select(enabled).catch(() => {}); })
          }.width('100%').constraintSize({ minHeight: 60 }).padding({ left: 16, right: 16, top: 8, bottom: 8 })
            .backgroundColor(this.themeSurface).borderRadius(16)
          Text(this.t('defaultViewDescription')).fontFamily('Geist').fontSize(13).lineHeight(18)
            .fontColor(this.themeSecondary).width('100%').padding({ left: 16, right: 16, top: 8 })
          if (this.error) {
            Text(this.t(this.error)).fontFamily('Geist').fontSize(13).lineHeight(18)
              .fontColor(this.themeStatusRed).width('100%').padding({ left: 16, right: 16, top: 8 })
          }
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
