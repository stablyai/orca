import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { KEY_TERMINAL_LINK_MODE, OptionEntry, readPagePreferencesSync, setString } from '../settings/SettingsStore';

const BROWSER_KEYS = 'settings.browserSettingsScreen.';
const LINK_MODES: OptionEntry[] = [
  { value: 'orca-browser', label: 'desktopBrowser', desc: 'desktopBrowserDescription' },
  { value: 'phone-browser', label: 'phoneBrowser', desc: 'phoneBrowserDescription' }
];

@Entry
@Component
struct BrowserSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @StorageProp('themeScheme') themeScheme: string = 'dark';
  @State value: string = 'orca-browser';
  @State error: string = '';
  @State saving: boolean = false;
  @State pickerOpen: boolean = false;

  aboutToAppear(): void {
    try {
      this.value = readPagePreferencesSync(getContext(this)).get(KEY_TERMINAL_LINK_MODE) ?? 'orca-browser';
    } catch (e) {
      this.error = 'loadFailed';
    }
  }

  private t(key: string): string {
    return uiText(BROWSER_KEYS + key, this.uiLocale);
  }

  private async select(value: string): Promise<void> {
    if (this.saving) { return; }
    this.pickerOpen = false;
    if (this.value === value && !this.error) { return; }
    const previous = this.value;
    this.saving = true;
    this.error = '';
    this.value = value;
    try {
      await setString(getContext(this), KEY_TERMINAL_LINK_MODE, value);
    } catch (e) {
      this.value = previous;
      this.error = 'saveFailed';
    } finally {
      this.saving = false;
    }
  }

  @Builder
  private pickerOption(option: OptionEntry) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Column({ space: 2 }) {
          Text(this.t(option.label)).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium)
            .fontColor(this.themeText)
          Text(this.t(option.desc)).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.value === option.value) {
          Image($r('app.media.lucide_check')).supportSvg2(true).width(17).height(17)
            .colorFilter(lucideColorFilter(this.themeText))
        } else {
          Row().width(17)
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(Color.Transparent)
      .accessibilitySelected(this.value === option.value)
      .onClick((): void => { this.select(option.value).catch(() => {}); })
  }

  @Builder
  private picker() {
    Column({ space: 8 }) {
      Text(this.t('openTerminalLinks')).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium)
        .fontColor(this.themeSecondary).width('100%').padding({ left: 16, right: 16 })
      Column() {
        ForEach(LINK_MODES, (option: OptionEntry, index: number) => {
          if (index > 0) { Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 }) }
          this.pickerOption(option)
        }, (option: OptionEntry): string => option.value)
      }.width('100%').borderRadius(16).clip(true)
        .backgroundColor(this.themeScheme === 'light' ? this.themeBg : this.themeRaised)
    }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 24 })
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('title') })
      Scroll() {
        Column() {
          Text(this.t('linksHeading')).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium)
            .fontColor(this.themeSecondary).width('100%').padding({ left: 16, bottom: 6 })
          Button({ type: ButtonType.Normal }) {
            Row({ space: 12 }) {
              Image($r('app.media.lucide_globe')).supportSvg2(true).width(18).height(18)
                .colorFilter(lucideColorFilter(this.themeSecondary))
              Column({ space: 2 }) {
                Text(this.t('openTerminalLinks')).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium)
                  .fontColor(this.themeText)
                Text(this.t(this.value === 'phone-browser' ? 'phoneBrowser' : 'desktopBrowser'))
                  .fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
              }.alignItems(HorizontalAlign.Start).layoutWeight(1)
              Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(15).height(15)
                .colorFilter(lucideColorFilter(this.themeMuted))
            }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
          }.width('100%').constraintSize({ minHeight: 60 }).backgroundColor(this.themeSurface).borderRadius(16)
            .accessibilityText(this.t('openTerminalLinks')).enabled(!this.saving)
            .onClick((): void => { this.pickerOpen = true; })
          Text(this.t('linksDescription')).fontFamily('Geist').fontSize(13).lineHeight(18)
            .fontColor(this.themeSecondary).width('100%').padding({ left: 16, right: 16, top: 8 })
          if (this.error) {
            Text(this.t(this.error)).fontFamily('Geist').fontSize(13).lineHeight(18)
              .fontColor(this.themeStatusRed).width('100%').padding({ left: 16, right: 16, top: 8 })
          }
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
      .bindSheet(this.pickerOpen, this.picker, { height: SheetSize.FIT_CONTENT,
        backgroundColor: this.themeSheet, maskColor: 'rgba(0,0,0,0.55)', showClose: false,
        onDisappear: (): void => { this.pickerOpen = false; } })
  }
}
