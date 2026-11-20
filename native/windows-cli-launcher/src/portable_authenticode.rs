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
    p_signature_settings: *mut c_void,
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

pub fn verify_authenticode(path: &Path, expected_publisher: Option<&str>) -> Result<String, String> {
    let wide_path = wide(path.as_os_str());
    let mut file_info = WinTrustFileInfo {
        cb_struct: size_of::<WinTrustFileInfo>() as u32,
        pcwsz_file_path: wide_path.as_ptr(),
        h_file: ptr::null_mut(),
        pg_known_subject: ptr::null(),
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
        p_signature_settings: ptr::null_mut(),
    };

    // SAFETY: WinTrustData and WinTrustFileInfo stay alive for both VERIFY and CLOSE calls.
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

    let signer = read_signer_display_name(&wide_path)?;
    if let Some(expected) = expected_publisher {
        if !signer.to_ascii_lowercase().contains(&expected.to_ascii_lowercase()) {
            return Err(format!(
                "Authenticode publisher mismatch for {}: expected '{}', got '{}'",
                path.display(),
                expected,
                signer
            ));
        }
    }
    Ok(signer)
}

fn read_signer_display_name(wide_path: &[u16]) -> Result<String, String> {
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

        let result = extract_signer_from_handles(store, msg);
        CertCloseStore(store, 0);
        CryptMsgClose(msg);
        result
    }
}

unsafe fn extract_signer_from_handles(
    store: *mut c_void,
    msg: *mut c_void,
) -> Result<String, String> {
    let mut signer_info_size = 0u32;
    if CryptMsgGetParam(
        msg,
        CMSG_SIGNER_INFO_PARAM,
        0,
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
        0,
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
