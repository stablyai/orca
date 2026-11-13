import { applyThemeMode } from '../settings/Appearance';
import { lucideColorFilter } from '../settings/LucideColor';
import { setUiLanguage, UI_LANGUAGE_CHOICES, UiLanguageChoice, uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { KEY_THEME_MODE, OptionEntry, setString, THEME_MODE_OPTIONS, THEME_MODE_SYSTEM } from '../settings/SettingsStore';

const APPEARANCE_KEYS = 'settings.appearance.';

@Entry
@Component
struct AppearanceSettings {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('uiLanguagePreference') language: string = 'system';
  @StorageProp('systemUiLocale') systemLocale: string = 'en';
  @StorageProp('themeMode') themeMode: string = THEME_MODE_SYSTEM;
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State saving: boolean = false;
  @State error: string = '';

  private t(key: string): string {
    return uiText(APPEARANCE_KEYS + key, this.uiLocale);
  }

  private languageLabel(choice: UiLanguageChoice): string {
    if (choice.value !== 'system') { return choice.label; }
    const language = UI_LANGUAGE_CHOICES.find((item: UiLanguageChoice): boolean => item.value === this.systemLocale);
    return this.t('language.systemWithCurrent').replace('{{language}}', language?.label ?? 'English');
  }

  private optionLabel(value: string, choice: UiLanguageChoice | null): string {
    return choice ? this.languageLabel(choice) : this.t('theme.' + value);
  }

  private optionSelected(value: string, choice: UiLanguageChoice | null): boolean {
    return value === (choice ? this.language : this.themeMode);
  }

  private async selectTheme(value: string): Promise<void> {
    if (this.saving) { return; }
    this.saving = true;
    this.error = '';
    try {
      await setString(getContext(this), KEY_THEME_MODE, value);
      applyThemeMode(value);
    } catch (e) {
      this.error = 'theme.saveFailed';
    } finally {
      this.saving = false;
    }
  }

  private async selectLanguage(value: string): Promise<void> {
    if (this.saving) { return; }
    this.saving = true;
    this.error = '';
    try {
      await setUiLanguage(getContext(this), value);
    } catch (e) {
      this.error = 'language.saveFailed';
    } finally {
      this.saving = false;
    }
  }

  @Builder
  private sectionHeading(label: string) {
    Text(label).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium)
      .fontColor(this.themeSecondary).width('100%').padding({ left: 16, right: 16, bottom: 6 })
  }

  @Builder
  private note(label: string, color: string) {
    Text(label).fontFamily('Geist').fontSize(13).lineHeight(18)
      .fontColor(color).width('100%').padding({ left: 16, right: 16, top: 8 })
  }

  @Builder
  private option(value: string, choice: UiLanguageChoice | null, onPress: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Text(this.optionLabel(value, choice)).fontFamily('Geist').fontSize(15)
          .fontColor(this.themeText).layoutWeight(1)
        if (this.optionSelected(value, choice)) {
          Image($r('app.media.lucide_check')).supportSvg2(true).width(17).height(17)
            .colorFilter(lucideColorFilter(this.themeText))
        } else {
          Row().width(17)
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }.width('100%').constraintSize({ minHeight: 48 }).backgroundColor(Color.Transparent)
      .accessibilityText(this.optionLabel(value, choice)).accessibilityRole(AccessibilityRoleType.RADIO)
      .accessibilitySelected(this.optionSelected(value, choice)).enabled(!this.saving).onClick(onPress)
  }

  @Builder
  private separator() {
    Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 16 })
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t('title') })
      Scroll() {
        Column({ space: 16 }) {
          Column() {
            this.sectionHeading(this.t('theme.heading'))
            Column() {
              ForEach(THEME_MODE_OPTIONS, (mode: OptionEntry, index: number) => {
                if (index > 0) { this.separator() }
                this.option(mode.value, null, (): void => {
                  this.selectTheme(mode.value).catch(() => {});
                })
              }, (mode: OptionEntry): string => mode.value)
            }.width('100%').borderRadius(16).backgroundColor(this.themeSurface).clip(true)
            this.note(this.t('theme.description'), this.themeSecondary)
            if (this.error === 'theme.saveFailed') { this.note(this.t(this.error), this.themeStatusRed) }
          }.width('100%')
          Column() {
            this.sectionHeading(this.t('language.heading'))
            Column() {
              ForEach(UI_LANGUAGE_CHOICES, (choice: UiLanguageChoice, index: number) => {
                if (index > 0) { this.separator() }
                this.option(choice.value, choice, (): void => {
                  this.selectLanguage(choice.value).catch(() => {});
                })
              }, (choice: UiLanguageChoice): string => choice.value)
            }.width('100%').borderRadius(16).backgroundColor(this.themeSurface).clip(true)
            this.note(this.t('language.description'), this.themeSecondary)
            if (this.error === 'language.saveFailed') { this.note(this.t(this.error), this.themeStatusRed) }
          }.width('100%')
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
