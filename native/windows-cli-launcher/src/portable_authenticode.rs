use std::ffi::{c_void, OsStr};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

const WTD_UI_NONE: u32 = 2;
const WTD_REVOKE_NONE: u32 = 0;
const WTD_CHOICE_FILE: u32 = 1;
const WTD_STATEACTION_VERIFY: u32 = 1;
const WTD_STATEACTION_CLOSE: u32 = 2;
const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x0000_1000;
const WTD_UICONTEXT_EXECUTE: u32 = 0;

const WSS_VERIFY_SPECIFIC: u32 = 0x0000_0001;
const WSS_GET_SECONDARY_SIG_COUNT: u32 = 0x0000_0002;

const X509_ASN_ENCODING: u32 = 0x0000_0001;
const PKCS_7_ASN_ENCODING: u32 = 0x0001_0000;
const CERT_QUERY_OBJECT_FILE: u32 = 1;
const CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBEDDED: u32 = 1 << 10;
const CERT_QUERY_FORMAT_FLAG_BINARY: u32 = 1 << 1;
const CMSG_SIGNER_INFO_PARAM: u32 = 6;
const CERT_FIND_SUBJECT_CERT: u32 = 0x000B_0000;
const CERT_NAME_SIMPLE_DISPLAY_TYPE: u32 = 4;

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

const WINTRUST_ACTION_GENERIC_VERIFY_V2: Guid = Guid {
    data1: 0x00AA_C56B,
    data2: 0xCD44,
    data3: 0x11D0,
    data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE],
};

#[repr(C)]
struct WinTrustFileInfo {
    cb_struct: u32,
    pcwsz_file_path: *const u16,
    h_file: *mut c_void,
    pg_known_subject: *const Guid,
}

#[repr(C)]
struct WinTrustSignatureSettings {
    cb_struct: u32,
    dw_index: u32,
    dw_flags: u32,
    c_secondary_sigs: u32,
    dw_verified_sig_index: u32,
    p_crypto_policy: *mut c_void,
}

#[repr(C)]
struct WinTrustData {
    cb_struct: u32,
    p_policy_callback_data: *mut c_void,
    p_sip_client_data: *mut c_void,
    dw_ui_choice: u32,
    fdw_revocation_checks: u32,
    dw_union_choice: u32,
    p_file: *mut WinTrustFileInfo,
    dw_state_action: u32,
    h_wvt_state_data: *mut c_void,
    pwsz_url_reference: *const u16,
    dw_prov_flags: u32,
    dw_ui_context: u32,
    p_signature_settings: *mut WinTrustSignatureSettings,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CryptoApiBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[repr(C)]
struct CryptAlgorithmIdentifier {
    psz_obj_id: *mut i8,
    parameters: CryptoApiBlob,
}

#[repr(C)]
struct CryptBitBlob {
    cb_data: u32,
    pb_data: *mut u8,
    c_unused_bits: u32,
}

#[repr(C)]
struct CertPublicKeyInfo {
    algorithm: CryptAlgorithmIdentifier,
    public_key: CryptBitBlob,
}

#[repr(C)]
struct CmsgSignerInfoHeader {
    dw_version: u32,
    issuer: CryptoApiBlob,
    serial_number: CryptoApiBlob,
}

#[repr(C)]
struct CertInfo {
    dw_version: u32,
    serial_number: CryptoApiBlob,
    signature_algorithm: CryptAlgorithmIdentifier,
    issuer: CryptoApiBlob,
    not_before: u64,
    not_after: u64,
    subject: CryptoApiBlob,
    subject_public_key_info: CertPublicKeyInfo,
    issuer_unique_id: CryptBitBlob,
    subject_unique_id: CryptBitBlob,
    c_extension: u32,
    rg_extension: *mut c_void,
}

#[link(name = "wintrust")]
extern "system" {
    fn WinVerifyTrust(hwnd: *mut c_void, action_id: *const Guid, data: *mut c_void) -> i32;
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptQueryObject(
        object_type: u32,
        object: *const c_void,
        expected_content_type_flags: u32,
        expected_format_type_flags: u32,
        flags: u32,
        msg_and_cert_encoding_type: *mut u32,
        content_type: *mut u32,
        format_type: *mut u32,
        cert_store: *mut *mut c_void,
        msg: *mut *mut c_void,
        context: *mut *const c_void,
    ) -> i32;
    fn CryptMsgGetParam(
        h_crypt_msg: *mut c_void,
        param_type: u32,
        index: u32,
        data: *mut c_void,
        data_len: *mut u32,
    ) -> i32;
    fn CertFindCertificateInStore(
        cert_store: *mut c_void,
        cert_encoding_type: u32,
        find_flags: u32,
        find_type: u32,
        find_para: *const c_void,
        prev_cert_context: *const c_void,
    ) -> *const c_void;
    fn CertGetNameStringW(
        cert_context: *const c_void,
        name_type: u32,
        flags: u32,
        type_para: *mut c_void,
        name_string: *mut u16,
        cch_name_string: u32,
    ) -> u32;
    fn CertFreeCertificateContext(cert_context: *const c_void) -> i32;
    fn CertCloseStore(cert_store: *mut c_void, flags: u32) -> i32;
    fn CryptMsgClose(h_crypt_msg: *mut c_void) -> i32;
}

#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(filename: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(
        filename: *const u16,
        handle: u32,
        len: u32,
        data: *mut c_void,
    ) -> i32;
    fn VerQueryValueW(
        block: *const c_void,
        sub_block: *const u16,
        buffer: *mut *const c_void,
        len: *mut u32,
    ) -> i32;
}

pub fn verify_authenticode(path: &Path, expected_publisher: Option<&str>) -> Result<String, String> {
    let wide_path = wide(path.as_os_str());
    let mut file_info = WinTrustFileInfo {
        cb_struct: size_of::<WinTrustFileInfo>() as u32,
        pcwsz_file_path: wide_path.as_ptr(),
        h_file: ptr::null_mut(),
        pg_known_subject: ptr::null(),
    };
    let mut sig_settings = WinTrustSignatureSettings {
        cb_struct: size_of::<WinTrustSignatureSettings>() as u32,
        dw_index: 0,
        dw_flags: WSS_VERIFY_SPECIFIC | WSS_GET_SECONDARY_SIG_COUNT,
        c_secondary_sigs: 0,
        dw_verified_sig_index: 0,
        p_crypto_policy: ptr::null_mut(),
    };
    let mut trust_data = WinTrustData {
        cb_struct: size_of::<WinTrustData>() as u32,
        p_policy_callback_data: ptr::null_mut(),
        p_sip_client_data: ptr::null_mut(),
        dw_ui_choice: WTD_UI_NONE,
        fdw_revocation_checks: WTD_REVOKE_NONE,
        dw_union_choice: WTD_CHOICE_FILE,
        p_file: &mut file_info,
        dw_state_action: WTD_STATEACTION_VERIFY,
        h_wvt_state_data: ptr::null_mut(),
        pwsz_url_reference: ptr::null(),
        dw_prov_flags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        dw_ui_context: WTD_UICONTEXT_EXECUTE,
        p_signature_settings: &mut sig_settings,
    };

    // SAFETY: WinTrustData, WinTrustFileInfo, and WinTrustSignatureSettings stay alive across VERIFY and CLOSE.
    let status = unsafe {
        let verify_status = WinVerifyTrust(
            ptr::null_mut(),
            &WINTRUST_ACTION_GENERIC_VERIFY_V2,
            (&mut trust_data as *mut WinTrustData).cast(),
        );
        trust_data.dw_state_action = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(
            ptr::null_mut(),
            &WINTRUST_ACTION_GENERIC_VERIFY_V2,
            (&mut trust_data as *mut WinTrustData).cast(),
        );
        verify_status
    };

    if status != 0 {
        return Err(format!(
            "Authenticode verification failed for {} (status 0x{:08x})",
            path.display(),
            status as u32
        ));
    }
    if sig_settings.c_secondary_sigs != 0 || sig_settings.dw_verified_sig_index != 0 {
        return Err(format!(
            "Refusing nested or non-primary Authenticode signature on {}",
            path.display()
        ));
    }

    let signer = read_signer_display_name(&wide_path, sig_settings.dw_verified_sig_index)?;
    if let Some(expected) = expected_publisher {
        if !signer.trim().eq_ignore_ascii_case(expected.trim()) {
            return Err(format!(
                "Authenticode publisher mismatch for {}: expected '{}', got '{}'",
                path.display(),
                expected,
                signer
            ));
        }
    }

    verify_signed_pe_orca_identity(path, &wide_path)?;
    Ok(signer)
}

fn verify_signed_pe_orca_identity(path: &Path, wide_path: &[u16]) -> Result<(), String> {
    let expected_filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid executable file name: {}", path.display()))?;

    // SAFETY: GetFileVersionInfoSizeW / GetFileVersionInfoW / VerQueryValueW read from bounded buffer.
    unsafe {
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut handle);
        if size == 0 {
            return Err(format!(
                "Signed executable {} is missing PE version metadata",
                path.display()
            ));
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(wide_path.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 {
            return Err(format!(
                "Could not read PE version metadata from {}",
                path.display()
            ));
        }

        let trans_query = wide(OsStr::new("\\VarFileInfo\\Translation"));
        let mut trans_ptr: *const c_void = ptr::null();
        let mut trans_len = 0u32;
        if VerQueryValueW(
            data.as_ptr().cast(),
            trans_query.as_ptr(),
            &mut trans_ptr,
            &mut trans_len,
        ) == 0
            || trans_ptr.is_null()
            || trans_len < 4
        {
            return Err(format!(
                "Signed executable {} is missing version translation table",
                path.display()
            ));
        }
        let lang_codepage = *(trans_ptr.cast::<[u16; 2]>());
        let prefix = format!(
            "\\StringFileInfo\\{:04x}{:04x}\\",
            lang_codepage[0], lang_codepage[1]
        );

        let product_name = query_version_string(&data, &format!("{prefix}ProductName"))?;
        if product_name.trim() != "Orca" {
            return Err(format!(
                "Signed executable {} belongs to product '{}', expected 'Orca'",
                path.display(),
                product_name
            ));
        }

        let original_filename = query_version_string(&data, &format!("{prefix}OriginalFilename"))?;
        if !original_filename
            .trim()
            .eq_ignore_ascii_case(expected_filename)
        {
            return Err(format!(
                "Signed executable {} OriginalFilename '{}' does not match '{}'",
                path.display(),
                original_filename,
                expected_filename
            ));
        }
    }
    Ok(())
}

unsafe fn query_version_string(data: &[u8], sub_block: &str) -> Result<String, String> {
    let query = wide(OsStr::new(sub_block));
    let mut value_ptr: *const c_void = ptr::null();
    let mut value_len = 0u32;
    if VerQueryValueW(
        data.as_ptr().cast(),
        query.as_ptr(),
        &mut value_ptr,
        &mut value_len,
    ) == 0
        || value_ptr.is_null()
        || value_len == 0
    {
        return Err(format!("Missing PE version field {sub_block}"));
    }
    let slice = std::slice::from_raw_parts(value_ptr.cast::<u16>(), value_len as usize);
    let end = slice.iter().position(|&ch| ch == 0).unwrap_or(slice.len());
    Ok(String::from_utf16_lossy(&slice[..end]))
}

fn read_signer_display_name(wide_path: &[u16], signer_index: u32) -> Result<String, String> {
    let mut encoding = 0u32;
    let mut content_type = 0u32;
    let mut format_type = 0u32;
    let mut store: *mut c_void = ptr::null_mut();
    let mut msg: *mut c_void = ptr::null_mut();

    // SAFETY: All output pointers are valid stack locals; returned handles are closed before return.
    unsafe {
        let queried = CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            wide_path.as_ptr().cast(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBEDDED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &mut encoding,
            &mut content_type,
            &mut format_type,
            &mut store,
            &mut msg,
            ptr::null_mut(),
        );
        if queried == 0 || store.is_null() || msg.is_null() {
            if !store.is_null() {
                CertCloseStore(store, 0);
            }
            if !msg.is_null() {
                CryptMsgClose(msg);
            }
            return Err("Could not read embedded Authenticode certificate".to_string());
        }

        let result = extract_signer_from_handles(store, msg, signer_index);
        CertCloseStore(store, 0);
        CryptMsgClose(msg);
        result
    }
}

unsafe fn extract_signer_from_handles(
    store: *mut c_void,
    msg: *mut c_void,
    signer_index: u32,
) -> Result<String, String> {
    let mut signer_info_size = 0u32;
    if CryptMsgGetParam(
        msg,
        CMSG_SIGNER_INFO_PARAM,
        signer_index,
        ptr::null_mut(),
        &mut signer_info_size,
    ) == 0
        || (signer_info_size as usize) < size_of::<CmsgSignerInfoHeader>()
    {
        return Err("Could not query signer info size".to_string());
    }

    let mut buffer = vec![0u8; signer_info_size as usize];
    if CryptMsgGetParam(
        msg,
        CMSG_SIGNER_INFO_PARAM,
        signer_index,
        buffer.as_mut_ptr().cast(),
        &mut signer_info_size,
    ) == 0
    {
        return Err("Could not read signer info".to_string());
    }

    let header = &*(buffer.as_ptr().cast::<CmsgSignerInfoHeader>());
    let mut cert_info: CertInfo = zeroed();
    cert_info.issuer = header.issuer;
    cert_info.serial_number = header.serial_number;

    let cert_ctx = CertFindCertificateInStore(
        store,
        X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
        0,
        CERT_FIND_SUBJECT_CERT,
        (&cert_info as *const CertInfo).cast(),
        ptr::null(),
    );
    if cert_ctx.is_null() {
        return Err("Could not locate signer certificate in Authenticode store".to_string());
    }

    let chars_needed = CertGetNameStringW(
        cert_ctx,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        ptr::null_mut(),
        ptr::null_mut(),
        0,
    );
    if chars_needed <= 1 {
        CertFreeCertificateContext(cert_ctx);
        return Err("Could not read signer display name".to_string());
    }

    let mut name_buf = vec![0u16; chars_needed as usize];
    let written = CertGetNameStringW(
        cert_ctx,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        ptr::null_mut(),
        name_buf.as_mut_ptr(),
        chars_needed,
    );
    CertFreeCertificateContext(cert_ctx);
    if written <= 1 {
        return Err("Signer display name was empty".to_string());
    }

    let end = (written as usize).saturating_sub(1);
    Ok(String::from_utf16_lossy(&name_buf[..end]))
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
